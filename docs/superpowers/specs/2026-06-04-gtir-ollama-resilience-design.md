# gtir Ollama Resilience — Design Spec

**Date:** 2026-06-04
**Status:** Approved design, pending implementation plan
**Repo:** `G:\demon\gtir`

## Problem

gtir embeds via the local Ollama daemon (`/api/embed`, `qwen3-embedding:0.6b`). The daemon is an external lifecycle dependency, and `src/embed.mjs` calls it with a bare `fetch` — no timeout, no retry. Three failure classes bite repeatedly:

1. **Daemon not running (#1)** — Ollama down after reboot / never started / crashed. Blocks both `index` and `search`. The MCP server is worst: it starts clean, then dies on the first query, so it looks broken rather than unconfigured.
2. **Cold-start stall (#5)** — Ollama unloads an idle model after ~5 min (default). The next embed triggers a multi-second reload. With no timeout, an interactive search or MCP query appears hung.
3. **Model not pulled (#2)** — only `gtir doctor` pulls the model. `index` and `mcp` do not preflight, so a fresh repo fails on the first embed with a low-context error instead of "run `gtir doctor`".

Edge failures (#3 pooling-type trap, #4 version drift, #6 batch stall) are out of scope — they are already handled by `doctor`, are rare, or fold into the retry layer below.

## Goals

- Survive a transient daemon blip or cold-model reload without a hard failure.
- Never hang forever on a stalled embed call.
- Fail **before** expensive work (file walk / chunk) when the daemon is hard-down or the model is missing, with an actionable message.
- No backend swap. No new MCP tool. Reuse `runDoctor`. Smallest blast radius.

## Non-Goals

- Replacing Ollama with another embedding backend (transformers.js, llama.cpp, fastembed). Explicitly rejected this session.
- Auto-spawning `ollama serve`.
- Preflight on the `search` hot path (latency-sensitive; covered by the retry layer instead).

## Architecture

Three components, layered. Component 1 is the foundation and covers every embed path cheaply; Components 2 and 3 add startup hardening for the long-lived / heavy commands only.

```
embed.mjs                         indexer.buildIndex / mcp start        search (hot path)
  embedOnce  (timeout, classify)        |                                   |
  embedBatch (retry/backoff)  <---------+-- warmup() ----+                  |
       ^                                |                |                   |
       |                          preflight (runDoctor pull:false)          |
       +--------------------------------------------------------------------+
                       (Component 1 retry covers search; no preflight there)
```

### Component 1 — `embed.mjs` resilience (foundation)

Replace the bare `fetch` in `embedBatch` with a timeout-wrapped single call plus a classified retry loop.

**Error classification:**
- **Retryable:** `AbortError` (timeout), network errors (`ECONNREFUSED`, `ECONNRESET`, `fetch failed`), HTTP status ≥ 500 (includes 503 "model loading").
- **Fatal (no retry):** HTTP 4xx (the capability error "does not support embeddings"), and malformed responses ("Ollama returned no embeddings array", length mismatch). These throw immediately, preserving the existing remediation message.

**Shape:**

```js
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    // AbortError (timeout) or network failure — retryable
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text?.().catch(() => "")) || res.status;
    const e = new Error(`Ollama embed failed (${detail}). Is Ollama running and the model pulled? Run: gtir doctor`);
    e.retryable = res.status >= 500;            // 5xx transient; 4xx fatal (capability error etc.)
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
      await sleep(backoff * 2 ** attempt);    // 500ms, 1s, 2s
    }
  }
}
```

`embedTexts` and `probeDim` are unchanged — they call `embedBatch`. `l2normalize`, `contentHash` unchanged.

**Note:** `cfg.fetchImpl` injection stays intact so the integration suite's mock Ollama and unit tests keep working. The retry loop honors the injected `fetchImpl`.

### Component 2 — `warmup(cfg)`

A single throwaway embed to force the model to load before real work, so the first real batch doesn't eat the cold-reload latency. Never fatal — preflight already reports hard-down/missing-model; warmup is best-effort latency hiding.

```js
export async function warmup(cfg) {
  try { await embedTexts(["warmup"], cfg); return true; }
  catch { return false; }
}
```

Called by `index` start and `mcp` start only (gated on `cfg.warmupOnStart`). **Not** called by `search`: its query embed self-warms, and a separate warmup would double the hot-path cost.

### Component 3 — preflight at startup

Gate the heavy / long-lived commands on a readiness check **before** they do expensive work. Reuse `runDoctor(cfg, { pull: false })` — it already runs reachable → model-present → capability → probe, and the probe doubles as a warmup. Do not pull at preflight (slow, surprising); direct the user to `gtir doctor`.

- **`gtir index`** (`runIndex` in `bin/gtir.mjs`): preflight before the file walk. On `!ready`, print `report` to stderr and exit non-zero with "run `gtir doctor`".
- **`gtir mcp`** (server startup in `src/mcp.mjs` / `serveStdio` path): preflight per configured index. A broken index is skipped with a logged note; healthy indexes still serve — matching the existing `defaultStatusFn` per-index tolerance. The server must not refuse to start just because one index's daemon/model is unready.
- **`gtir search`**: **no preflight**. Latency-sensitive one-shot. Relies on Component 1 retry plus the existing remediation message surfaced by its own query embed.

**Preflight vs warmup — no double work.** `runDoctor`'s probe already loads the model, so preflight *is* the warmup for `index` and `mcp`. Do not call `warmup()` after a preflight on the same startup. `cfg.warmupOnStart` is the single gate for this pre-load: when `true`, `index`/`mcp` run preflight (probe warms the model) before serving/walking; when `false`, both skip preflight and trust Component 1's retry layer to absorb a cold reload. `warmup()` stays exported and unit-tested as a standalone primitive — its only runtime use is a future path that wants pre-load without a full readiness report; no current path calls it directly.

### Config knobs (`src/config.mjs` `DEFAULTS`)

```js
embedTimeoutMs: 60000,      // per-batch embed call timeout (cold reload of a 4b override fits)
embedRetries: 2,            // retry count for retryable failures
embedRetryBackoffMs: 500,   // exponential backoff base (500ms, 1s, 2s)
warmupOnStart: true,        // gate preflight+probe pre-load on index + mcp start (false = skip, trust C1 retry)
```

All overridable per-repo via `.gtir/config.json` (existing merge path in `loadConfig`).

## Error Handling Summary

| Situation | Layer | Behavior |
|---|---|---|
| Embed call times out | C1 | Abort, retry up to `embedRetries`, then throw with remediation |
| Daemon transient blip mid-index | C1 | Retry with backoff; succeed if it recovers |
| Model 503 "loading" | C1 | Retryable; backoff covers reload window |
| Capability error (4xx) | C1 | Fatal, no retry, existing `notEmbedHint`-style message |
| Daemon hard-down at `index`/`mcp` start | C3 | Preflight fails fast, prints report, "run gtir doctor" |
| Model missing at `index`/`mcp` start | C3 | Preflight fails fast, "run gtir doctor" |
| One bad index among many at `mcp` start | C3 | Skip it, serve the rest, log a note |
| Daemon down at `search` | C1 | Query embed retries, then throws remediation (no preflight) |

## Testing

Existing infra: `cfg.fetchImpl` injection (unit) + `test/integration.test.mjs` mock-Ollama HTTP server.

**Unit — `embed.mjs`:**
- Timeout: `fetchImpl` that never resolves → `embedBatch` aborts, retries `embedRetries` times, throws after exhaustion. Assert attempt count = `retries + 1`.
- Recover: `fetchImpl` returns HTTP 503 twice then 200 → `embedBatch` resolves with embeddings. Assert it succeeded on the 3rd call.
- Fatal-no-retry: `fetchImpl` returns HTTP 400 → throws immediately, **1** call only (assert no retry).
- Malformed: response with no `embeddings` array → throws, no retry.

**Unit — `warmup`:**
- Success path → returns `true`, calls embed once with `["warmup"]`.
- Failing embed → returns `false`, error swallowed (no throw).

**Unit — preflight:**
- Mock unreachable Ollama (`/api/version` fails) → preflight reports not-ready with actionable detail.
- Mock reachable + model absent in `/api/tags` → not-ready, "run gtir doctor".
- Mock reachable + model present + probe ok → ready, proceeds.

**Integration (mock-Ollama):**
- Add a case where the mock drops the first `/api/embed` request (network error) and succeeds on retry → `index` completes without failure.

## Files Touched

- `src/embed.mjs` — `embedOnce` (new), `embedBatch` (retry loop), `warmup` (new export). `embedTexts`, `probeDim`, `l2normalize`, `contentHash` unchanged.
- `src/config.mjs` — 4 new `DEFAULTS` keys.
- `bin/gtir.mjs` — preflight in `runIndex` before walk.
- `src/mcp.mjs` — per-index preflight at server startup; skip-and-log broken indexes.
- `test/embed.test.mjs` (or existing embed test) — unit cases above.
- `test/integration.test.mjs` — drop-first-request retry case.

## Out of Scope / Future

- Backend swap (transformers.js / llama.cpp unify with rerank / fastembed) — separate decision, declined this session.
- Auto-`ollama serve` spawn.
- MCP-triggered re-index, diff-scoped search (tool-surface adds, unrelated).
