// `gtir doctor` — one command that gets a machine ready: checks Node + Ollama, pulls the embedding
// model if it's missing, verifies embeddings work, and prints a ✓/✗ readiness report. Removes the
// manual `ollama pull …` step that used to sit between install and first index.
import { probeDim } from "./embed.mjs";

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
      try { dim = await probeDim(cfg); checks.push({ name: `embeddings (dim=${dim})`, ok: true }); }
      catch (e) { checks.push({ name: "embeddings", ok: false, detail: e.message }); }
    }
  }

  const { text, ready } = formatReport(checks);
  return { ready, dim, checks, report: text };
}
