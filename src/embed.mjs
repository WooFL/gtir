import { createHash } from "node:crypto";

export function l2normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// One /api/embed call, time-boxed. Tags thrown errors with `.retryable` so embedBatch
// knows whether to back off and try again (timeout / network / 5xx) or give up (4xx / bad shape).
async function embedOnce(texts, cfg, timeoutMs) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${cfg.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: texts.map((t) => t.slice(0, cfg.maxEmbedChars ?? 6000)) }),
      signal: ac.signal,
    });
  } catch (err) {
    // Wrap rather than mutate the platform error (AbortError/network) — keeps the name+message
    // for callers/tests and avoids assigning to a possibly-frozen runtime error object.
    const e = new Error(err.message, { cause: err });
    e.name = err.name;      // preserve "AbortError" so timeout callers can detect it
    e.retryable = true;     // AbortError (timeout) or network failure
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text?.().catch(() => "")) || res.status;
    const e = new Error(`Ollama embed failed (${detail}). Is Ollama running and the model pulled? Run: gtir doctor`);
    e.retryable = res.status >= 500;   // 5xx transient; 4xx fatal (capability error etc.)
    throw e;
  }
  const data = await res.json();
  if (!data.embeddings) { const e = new Error("Ollama returned no embeddings array"); e.retryable = false; throw e; }
  if (data.embeddings.length !== texts.length) {
    const e = new Error(`Ollama returned ${data.embeddings.length} embeddings for ${texts.length} inputs`);
    e.retryable = false; throw e;
  }
  return data.embeddings.map(l2normalize);
}

async function embedBatch(texts, cfg) {
  const timeoutMs = cfg.embedTimeoutMs ?? 60000;
  const retries   = cfg.embedRetries ?? 2;
  const backoff   = cfg.embedRetryBackoffMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await embedOnce(texts, cfg, timeoutMs);
    } catch (e) {
      if (!e.retryable || attempt >= retries) throw e;
      await sleep(backoff * 2 ** attempt);
    }
  }
}

export async function embedTexts(texts, cfg) {
  const batch = cfg.embedBatch ?? 32;
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    out.push(...await embedBatch(texts.slice(i, i + batch), cfg));
  }
  return out;
}

export async function probeDim(cfg) {
  const [v] = await embedTexts(["ping"], cfg);
  return v.length;
}

export function contentHash(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}
