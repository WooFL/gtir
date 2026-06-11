// `gtir doctor` — one command that gets a machine ready: checks Node + Ollama, pulls the embedding
// model if it's missing, verifies embeddings work, and prints a ✓/✗ readiness report. Removes the
// manual `ollama pull …` step that used to sit between install and first index.
import { probeDim } from "./embed.mjs";
import { probeDim as tfProbeDim } from "./transformers-embed.mjs";
import { embedIdentity } from "./config.mjs";

// Is `model` in the /api/tags list? Ollama reports "name:tag"; tolerate a missing ":latest".
export function modelPresent(tags, model) {
  const names = (tags?.models ?? []).map((m) => String(m.name || m.model || ""));
  const norm = (s) => s.replace(/:latest$/, "");
  return names.some((n) => n === model || norm(n) === norm(model));
}

// Render the checks as a ✓/!/✗ block; ready iff nothing failed (warnings are tolerated).
export function formatReport(checks) {
  const mark = (ok) => (ok === true ? "✓" : ok === "warn" ? "!" : "✗");
  const text = checks.map((c) => `  ${mark(c.ok)}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`).join("\n");
  return { text, ready: checks.every((c) => c.ok !== false) };
}

async function getJSON(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// POST /api/show → model metadata including `capabilities` (e.g. ["embedding"] vs ["completion"]).
async function showModel(cfg, fetchImpl) {
  const res = await fetchImpl(`${cfg.ollamaUrl}/api/show`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Why a present, pullable model still can't embed: Ollama only flags a model embedding-capable
// when its GGUF carries `pooling_type` metadata. Decoder models repackaged as embedders (the
// jina-code GGUF, GTE-Qwen2, …) often lack it, so Ollama's engine loads them completion-only and
// /api/embed fails with "does not support embeddings". This is the actionable remediation.
export function notEmbedHint(model, caps) {
  return `Ollama loaded "${model}" with capabilities ${JSON.stringify(caps ?? [])} — it can't serve embeddings `
    + `(its GGUF has no pooling_type metadata, which Ollama's engine requires). Use an embedding-native model `
    + `— the default qwen3-embedding:0.6b, or nomic-embed-text — or set "model" in .gtir/config.json. `
    + `To keep a decoder model like jina-code, run it under llama-server (see the README "Embedding model" notes).`;
}

// Stream POST /api/pull, surfacing distinct status lines (e.g. "pulling manifest" → "success").
async function pullModel(cfg, fetchImpl, log) {
  const res = await fetchImpl(`${cfg.ollamaUrl}/api/pull`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`pull failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", last = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.error) throw new Error(msg.error);
      if (msg.status && msg.status !== last) { last = msg.status; log(`pulling: ${msg.status}`); }
    }
  }
}

// Run the readiness checks. `pull` (default true) downloads the model if it's missing.
// Network I/O goes through cfg.fetchImpl ?? fetch, so tests inject a mock Ollama.
export async function runDoctor(cfg, { pull = true, log = () => {} } = {}) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const checks = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: `Node ${process.versions.node}`, ok: nodeMajor >= 20, detail: nodeMajor >= 20 ? null : "gtir needs Node ≥ 20" });

  // Transformers backend: no Ollama server to check. Readiness = the @huggingface/transformers dep is
  // installed and the model loads (which warms the on-disk cache when remote is allowed, or proves the
  // offline bundle is staged when transformersLocalOnly). The same probe doubles as a warmup.
  if (cfg.embedBackend === "transformers") {
    checks.push({ name: `embed backend: transformers (in-process ONNX, no server)`, ok: true,
      detail: `${embedIdentity(cfg)}${cfg.transformersLocalOnly ? " · local-only" : ""}${cfg.transformersCacheDir ? ` · cache ${cfg.transformersCacheDir}` : ""}` });
    let dim = null;
    try {
      if (cfg.transformersLocalOnly) log("verifying staged model (offline)…");
      else log("loading model (first run downloads it; this warms the offline cache)…");
      dim = await tfProbeDim(cfg);
      checks.push({ name: `transformers embeddings (dim=${dim})`, ok: true });
    } catch (e) {
      const missingDep = /Cannot find (package|module)|@huggingface\/transformers/i.test(e.message);
      const hint = missingDep
        ? " — run: npm i @huggingface/transformers"
        : cfg.transformersLocalOnly
          ? " — model not staged for offline use; run `gtir doctor` once with transformersLocalOnly off (or with network) to warm the cache, then re-enable it"
          : "";
      checks.push({ name: "transformers embeddings", ok: false, detail: e.message + hint });
    }
    const { text, ready } = formatReport(checks);
    return { ready, dim, checks, report: text };
  }

  let reachable = false;
  try { await getJSON(`${cfg.ollamaUrl}/api/version`, fetchImpl); reachable = true; checks.push({ name: `Ollama reachable at ${cfg.ollamaUrl}`, ok: true }); }
  catch (e) { checks.push({ name: `Ollama at ${cfg.ollamaUrl}`, ok: false, detail: `${e.message} — is it running? (install: https://ollama.com)` }); }

  let dim = null;
  if (reachable) {
    let present = false;
    try { present = modelPresent(await getJSON(`${cfg.ollamaUrl}/api/tags`, fetchImpl), cfg.model); } catch { /* treat as missing */ }

    if (!present && pull) {
      log(`model ${cfg.model} not found — pulling (one-time, ~1 GB)…`);
      try { await pullModel(cfg, fetchImpl, log); present = true; }
      catch (e) { checks.push({ name: `pull ${cfg.model}`, ok: false, detail: e.message }); }
    }
    if (present) checks.push({ name: `model ${cfg.model}`, ok: true });
    else if (!checks.some((c) => c.name.startsWith("pull "))) {
      checks.push({ name: `model ${cfg.model}`, ok: false, detail: `missing — run: ollama pull ${cfg.model}` });
    }

    if (present) {
      // Capability pre-check: catch the "completion-only" model up front with an actionable
      // message, instead of letting the probe fail with llama.cpp's opaque "--embeddings" error.
      let caps = null;
      try { caps = (await showModel(cfg, fetchImpl)).capabilities ?? null; }
      catch { /* older Ollama may lack /api/show capabilities — fall through to the live probe */ }
      if (caps && !caps.includes("embedding")) {
        checks.push({ name: "embeddings", ok: false, detail: notEmbedHint(cfg.model, caps) });
      } else {
        try { dim = await probeDim(cfg); checks.push({ name: `embeddings (dim=${dim})`, ok: true }); }
        catch (e) {
          const hint = /does not support embeddings|--embeddings/i.test(e.message) ? ` ${notEmbedHint(cfg.model, caps)}` : "";
          checks.push({ name: "embeddings", ok: false, detail: e.message + hint });
        }
      }
    }
  }

  const { text, ready } = formatReport(checks);
  return { ready, dim, checks, report: text };
}

// Fast readiness gate for commands that do expensive work (`index`, `mcp`). Reuses runDoctor's
// reachable → model-present → capability → probe checks (the probe doubles as a warmup), but never
// pulls. On not-ready, throws an Error whose message is the ✓/✗ report plus "run: gtir doctor",
// so the caller can print it and exit non-zero BEFORE walking files / serving.
export async function preflight(cfg) {
  const { ready, dim, report } = await runDoctor(cfg, { pull: false });
  if (!ready) throw new Error(`${report}\n\ngtir: Ollama not ready — run: gtir doctor`);
  return { dim };
}
