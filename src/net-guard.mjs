// Zero-egress guard (Moat B). The single source of truth for "which hosts is gtir allowed to
// contact at runtime". Pure + dependency-free: the configured embed/rerank endpoints are the
// ONLY hosts permitted; embed.mjs/rerank.mjs call assertConfiguredUrl before every fetch so any
// future code that tries a stray host throws loudly rather than silently phoning home.

// The host[:port] of cfg.ollamaUrl and (when present) cfg.rerankUrl, parsed via new URL().
// Lenient: a missing/blank rerankUrl is simply omitted.
export function configuredHosts(cfg = {}) {
  const hosts = new Set();
  for (const raw of [cfg.ollamaUrl, cfg.rerankUrl]) {
    if (!raw) continue;
    try { hosts.add(new URL(raw).host); } catch { /* malformed URL → contributes no allowed host */ }
  }
  return hosts;
}

// Throw if `url`'s host isn't one of the configured endpoints; otherwise return the url unchanged.
// The thrown Error names the offending host so a stray egress fails loudly and traceably.
export function assertConfiguredUrl(url, cfg = {}) {
  const host = new URL(url).host;
  const allowed = configuredHosts(cfg);
  if (!allowed.has(host)) {
    throw new Error(
      `zero-egress guard: refusing to contact non-configured host "${host}" — ` +
      `gtir only talks to ${[...allowed].join(", ") || "(no configured endpoints)"}`,
    );
  }
  return url;
}
