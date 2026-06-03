import { resolve, basename, relative } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { search } from "./search.mjs";
import { openStore } from "./store.mjs";
import { parseLines } from "./eval.mjs";
import { watchRepo } from "./watch.mjs";

export function sanitizeLabel(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "index";
}

export function deriveLabel(repo, cfg, override) {
  if (override) return sanitizeLabel(override);
  const m = cfg?.model || "";
  if (/nomic/i.test(m)) return "notes";
  if (/jina.*code/i.test(m) || /qwen3.?embedding/i.test(m)) return "code";
  return sanitizeLabel(basename(repo));
}

// overrides: { [repoArg]: label } — keyed by the SAME raw string passed in `repos`
// (the CLI must pass identical strings for --repo and the --label <name>:<repo> target,
// else the override silently misses and the label falls back to model-derived).
// repos: raw --repo args (loadConfig resolves them internally).
export function resolveIndexes(repos, overrides = {}) {
  const indexes = [];
  const seen = new Map(); // label -> repo
  for (const repo of repos) {
    const cfg = loadConfig(repo);
    const label = deriveLabel(resolve(repo), cfg, overrides[repo]);
    if (seen.has(label)) {
      throw new Error(
        `two indexes resolved to '${label}' (${seen.get(label)} and ${cfg.repo}) — ` +
        `disambiguate with --label <name>:<repo>`,
      );
    }
    seen.set(label, cfg.repo);
    indexes.push({ label, repo: cfg.repo, cfg });
  }
  return indexes;
}

export function buildTools(indexes) {
  const tools = [];
  for (const ix of indexes) {
    const at = `the ${ix.label} index at ${ix.repo}`;
    tools.push({
      name: `search_${ix.label}`,
      description: `Hybrid semantic + lexical (vector + BM25 + RRF) search over ${at}. Returns ranked chunks.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "natural-language search query" },
          k: { type: "integer", description: "max results (default 8)" },
          path_prefix: { type: "string", description: "restrict to paths under this prefix" },
          language: { type: "string", description: "restrict to a language (code indexes)" },
          compact: { type: "boolean", description: "omit the code snippet — return path/lines/score only (token-saving)" },
        },
        required: ["query"],
      },
    });
    tools.push({
      name: `read_${ix.label}`,
      description: `Read the source of a span in ${at}. Use after a search hit to see more — pass the hit's path and lines.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "file path, relative to the repo root" },
          lines: { type: "string", description: 'line range like "42-71" (or a single line); omit for the whole file' },
          context: { type: "integer", description: "extra lines before/after the range (0-50, default 3)" },
        },
        required: ["path"],
      },
    });
    tools.push({
      name: `outline_${ix.label}`,
      description: `List the indexed chunks of one file in ${at} — each with its line range and signature. A cheap map of a file.`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "file path, relative to the repo root" } },
        required: ["path"],
      },
    });
    tools.push({
      name: `similar_${ix.label}`,
      description: `Find chunks semantically similar to a span in ${at} — pass a path and a line inside the chunk of interest.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "file path, relative to the repo root" },
          line: { type: "integer", description: "a line inside the chunk to match (default: the file's first chunk)" },
          limit: { type: "integer", description: "max results (default 8)" },
        },
        required: ["path"],
      },
    });
    tools.push({
      name: `find_${ix.label}`,
      description: `Jump to a symbol in ${at} by exact name. kind="definition" (default) returns where it's declared; ` +
        `kind="references" is a lexical sweep of where the name appears (not type-resolved — same-named symbols collide). ` +
        `Prefer this over search when you already know the exact name.`,
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "exact symbol name (function, class, type, …)" },
          kind: { type: "string", enum: ["definition", "references"], description: 'definition (default) or references' },
          limit: { type: "integer", description: "max results (default 25)" },
        },
        required: ["symbol"],
      },
    });
  }
  tools.push({
    name: "gtir_status",
    description: "List the indexes this gtir MCP server serves, with model, dim, file/chunk count, and last-built time.",
    inputSchema: { type: "object", properties: {} },
  });
  return tools;
}

export async function handleRequest(msg, ctx) {
  const { indexes, version } = ctx;
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "gtir", version: version ?? "0.0.0" },
      });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return reply({ tools: buildTools(indexes) });
    case "tools/call":
      return reply(await dispatchToolCall(msg.params ?? {}, ctx));
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

function branchTag(r) {
  return [r.vec_rank ? `v${r.vec_rank}` : null, r.fts_rank ? `f${r.fts_rank}` : null].filter(Boolean).join("+") || "—";
}

function formatHits(results) {
  if (!results.length) return "(no matches)";
  return results.map((r) =>
    `### ${r.path}:${r.lines}  _(rrf=${r.score} · ${branchTag(r)})_\n\`\`\`\n${r.snippet}\n\`\`\``,
  ).join("\n\n");
}

function formatCompact(results) {
  if (!results.length) return "(no matches)";
  return results.map((r) => `- ${r.path}:${r.lines}  _(rrf=${r.score} · ${branchTag(r)})_`).join("\n");
}

function formatRead(out) {
  return `### ${out.path}:${out.lines}\n\`\`\`\n${out.text}\n\`\`\``;
}

function formatOutline(out) {
  if (!out.symbols.length) return `(${out.path}: not indexed, or no chunks)`;
  const body = out.symbols.map((s) => `- \`${s.lines}\`  ${s.signature}`).join("\n");
  return `### ${out.path} — ${out.symbols.length} chunk(s)\n${body}`;
}

// First meaningful (non-comment) line of a chunk — a readable "signature" for outlines.
function signatureOf(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const sig = lines.find((l) => !/^(\/\/|#|\*|\/\*|--|<!--)/.test(l)) || lines[0] || "";
  return sig.length > 100 ? sig.slice(0, 99) + "…" : sig;
}

// Keywords that look like a function name in front of "(...) {" but are control flow / language
// keywords, not definitions — excluded from the C-family pass below.
const NOT_A_DEFINITION = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "do", "else", "decltype",
  "constexpr", "requires", "static_assert", "function", "operator", "typedef", "using", "namespace",
]);

// Every identifier this chunk *declares* — heuristic (not tree-sitter-precise), used to tell a
// definition site from a mention. Two passes:
//   1) keyword-declared symbols (function/def/class/struct/… across languages).
//   2) C-family function/method DEFINITIONS — `[Class::]name(params) [quals] [: init] {`. The body
//      brace distinguishes a definition from a call (`foo();`) or prototype (`int foo();`); the
//      optional `Class::` prefix captures the method name (so `void Cache::write(...) {` → `write`).
export function declaredSymbols(text) {
  const s = String(text || "");
  const out = new Set();
  let m;
  const kw = /\b(?:function|func|def|class|fn|interface|type|struct|impl|trait|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = kw.exec(s))) out.add(m[1]);
  const cfn = /(?:^|[\s;{}*&])(?:[A-Za-z_]\w*\s*::\s*)*([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:noexcept|const|override|final|mutable|volatile|->[\w:<>,*&\s]+|\s)*(?::[^{};]*)?\{/g;
  while ((m = cfn.exec(s))) if (!NOT_A_DEFINITION.has(m[1])) out.add(m[1]);
  return [...out];
}

function formatFind(results, symbol, kind) {
  if (!results.length) return `(no ${kind} found for "${symbol}")`;
  return results.map((r) =>
    `### ${r.path}:${r.lines}  _(${r.kind})_\n\`\`\`\n${r.snippet}\n\`\`\``,
  ).join("\n\n");
}

const TOOL_VERBS = ["search", "read", "outline", "similar", "find"];

// "search_my_wiki" -> { verb: "search", label: "my_wiki" } (labels may contain underscores).
export function parseToolName(name) {
  for (const v of TOOL_VERBS) {
    if (typeof name === "string" && name.startsWith(v + "_")) return { verb: v, label: name.slice(v.length + 1) };
  }
  return null;
}

const stripSnippet = (results) => results.map(({ snippet, ...rest }) => rest);

async function dispatchToolCall(params, ctx) {
  const { indexes, searchFn, statusFn, readFn, outlineFn, similarFn, findFn } = ctx;
  const name = params.name;
  const args = params.arguments ?? {};
  const reply = (text, structured) => ({ content: [{ type: "text", text }], structuredContent: structured });
  try {
    if (name === "gtir_status") {
      const status = await statusFn();
      return reply(JSON.stringify(status, null, 2), { indexes: status });
    }
    const parsed = parseToolName(name);
    if (parsed) {
      const { verb, label } = parsed;
      if (!indexes.some((ix) => ix.label === label)) {
        return { content: [{ type: "text", text: `unknown index: ${label}` }], isError: true };
      }
      if (verb === "search") {
        let results = await searchFn(label, { query: args.query, k: args.k, pathPrefix: args.path_prefix, language: args.language });
        if (args.compact) results = stripSnippet(results);
        return reply(args.compact ? formatCompact(results) : formatHits(results), { results });
      }
      if (verb === "read") {
        const out = await readFn(label, { path: args.path, lines: args.lines, context: args.context });
        return reply(formatRead(out), out);
      }
      if (verb === "outline") {
        const out = await outlineFn(label, { path: args.path });
        return reply(formatOutline(out), out);
      }
      if (verb === "similar") {
        const results = await similarFn(label, { path: args.path, line: args.line, limit: args.limit });
        return reply(formatHits(results), { results });
      }
      if (verb === "find") {
        const kind = args.kind === "references" ? "references" : "definition";
        const results = await findFn(label, { symbol: args.symbol, kind, limit: args.limit });
        return reply(formatFind(results, args.symbol, kind), { symbol: args.symbol, kind, results });
      }
    }
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
}

export function defaultSearchFn(indexes) {
  return async (label, args) => {
    const ix = indexes.find((i) => i.label === label);
    return search(args.query, ix.cfg, { k: args.k, pathPrefix: args.pathPrefix, language: args.language });
  };
}

export function defaultStatusFn(indexes) {
  return async () => Promise.all(indexes.map(async (ix) => {
    try {
      const store = await openStore(ix.cfg);
      const meta = await store.readMeta();
      const man = await store.loadManifest();
      const builtAt = Number(meta.built_at) || 0;
      const dim = meta.dim ?? null;
      return {
        label: ix.label, repo: ix.repo,
        model: meta.model ?? ix.cfg.model, dim,
        files: Object.keys(man).length, built_at: builtAt,
        age_minutes: builtAt ? Math.round((Date.now() / 1000 - builtAt) / 60) : null,
        healthy: !!dim,
        ...(dim ? {} : { note: `index not built — run: gtir index --repo ${ix.repo}` }),
      };
    } catch (e) {
      // One broken/corrupt store must not blank out the others.
      return { label: ix.label, repo: ix.repo, healthy: false, note: `index unreadable: ${e.message}` };
    }
  }));
}

// Read a file span from disk (the index isn't needed — just the chunk's path + lines).
// Guards against path traversal outside the index's repo root.
export function defaultReadFn(indexes) {
  return async (label, { path, lines = null, context = 3 }) => {
    const ix = indexes.find((i) => i.label === label);
    if (!path) throw new Error("path is required");
    const abs = resolve(ix.repo, path);
    if (relative(ix.repo, abs).startsWith("..")) throw new Error("path escapes the repo");
    const body = readFileSync(abs, "utf8").split("\n");
    let [s, e] = lines ? parseLines(lines) : [1, body.length];
    if (!Number.isFinite(s)) s = 1;
    if (!Number.isFinite(e)) e = s;
    const ctxN = Math.max(0, Math.min(50, (context | 0) || 0));
    const start = Math.max(1, s - ctxN), end = Math.min(body.length, Math.max(s, e) + ctxN);
    return { path, lines: `${start}-${end}`, language: ix.cfg?.language ?? null, text: body.slice(start - 1, end).join("\n") };
  };
}

// List a file's indexed chunks (line range + a one-line signature) — a cheap file map.
export function defaultOutlineFn(indexes) {
  return async (label, { path }) => {
    const ix = indexes.find((i) => i.label === label);
    if (!path) throw new Error("path is required");
    const store = await openStore(ix.cfg);
    const rows = await store.chunksByPath(path);
    return { path, symbols: rows.map((r) => ({ lines: `${r.line_start}-${r.line_end}`, language: r.language, signature: signatureOf(r.text) })) };
  };
}

// Nearest chunks to the one covering (path, line) — reuses the stored embedding, no re-embed.
export function defaultSimilarFn(indexes) {
  return async (label, { path, line = null, limit = 8 }) => {
    const ix = indexes.find((i) => i.label === label);
    if (!path) throw new Error("path is required");
    const store = await openStore(ix.cfg);
    const src = await store.chunkAt(path, line);
    if (!src) throw new Error(`no indexed chunk at ${path}${line != null ? `:${line}` : ""}`);
    const tbl = await store.chunksTable();
    const k = Math.max(1, Math.min(25, (limit | 0) || 8));
    const rows = await tbl.search(Array.from(src.embedding)).distanceType("cosine").limit(k + 4).toArray();
    const out = [];
    for (const r of rows) {
      if (r.id === src.id) continue;            // the seed chunk itself
      out.push({ path: r.path, lines: `${r.line_start}-${r.line_end}`, language: r.language,
        score: Number((1 - (r._distance ?? 0)).toFixed(4)), snippet: r.text });
      if (out.length >= k) break;
    }
    return out;
  };
}

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Symbol jump. Prefilter via the BM25 index (chunks that mention the name — no full scan), then
// keep declaration sites (kind=definition) or whole-word name matches (kind=references, lexical).
export function defaultFindFn(indexes) {
  return async (label, { symbol, kind = "definition", limit = 25 }) => {
    const ix = indexes.find((i) => i.label === label);
    if (!symbol) throw new Error("symbol is required");
    const store = await openStore(ix.cfg);
    const tbl = await store.chunksTable();
    if (!tbl) throw new Error(`no index at ${ix.cfg.indexDir} — run: gtir index --repo ${ix.repo}`);
    const k = Math.max(1, Math.min(100, (limit | 0) || 25));
    // Scan a wide BM25 candidate pool: a definition can rank below many mention/call chunks for a
    // heavily-referenced symbol, so a narrow fan would miss it. Scanning is a cheap regex per chunk.
    const fan = Math.min(1000, Math.max(k * 4, ix.cfg.findCandidates ?? 200));
    let cand;
    try { cand = await tbl.query().nearestToText(symbol, ["fts_text"]).limit(fan).toArray(); }
    catch {
      try { cand = await tbl.query().nearestToText(symbol, undefined).limit(fan).toArray(); }
      catch { cand = await tbl.query().limit(5000).toArray(); }   // no FTS: degrade to a scan
    }
    const word = new RegExp(`(?:^|[^\\w$])${reEsc(symbol)}(?![\\w$])`);
    const isDef = (r) => declaredSymbols(r.text).includes(symbol);
    const rows = (kind === "references" ? cand.filter((r) => word.test(r.text)) : cand.filter(isDef)).slice(0, k);
    return rows.map((r) => ({
      path: r.path, lines: `${r.line_start}-${r.line_end}`, language: r.language,
      kind: isDef(r) ? "definition" : "reference", snippet: r.text,
    }));
  };
}

export function serveStdio(indexes, { version } = {}) {
  const ctx = {
    indexes, version,
    searchFn: defaultSearchFn(indexes), statusFn: defaultStatusFn(indexes),
    readFn: defaultReadFn(indexes), outlineFn: defaultOutlineFn(indexes),
    similarFn: defaultSimilarFn(indexes), findFn: defaultFindFn(indexes),
  };
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const res = await handleRequest(msg, ctx);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  });
  process.stderr.write(`gtir mcp: serving [${indexes.map((i) => i.label).join(", ")}] × {search,read,outline,similar,find} + gtir_status\n`);
}

// Start a live file-watcher per served index (`gtir mcp --watch`). Each watcher runs an
// incremental refresh on a debounced batch of changes and defers during git operations (the
// same gitBusy gate as the commit hooks), so the index the agent queries tracks the working
// tree as you edit — no commit required. `log` MUST route to stderr; stdout is the JSON-RPC
// channel and any stray write corrupts the protocol. Returns the handles so callers can close them.
export function startWatchers(indexes, { debounceMs = 1500, log = () => {} } = {}) {
  return indexes.map((ix) => {
    const handle = watchRepo(ix.cfg, { debounceMs, log: (m) => log(`[${ix.label}] ${m}`) });
    return { label: ix.label, ...handle };
  });
}

export function printConfig(repos, { watch = false, debounceMs = null } = {}) {
  const gtirBin = fileURLToPath(new URL("../bin/gtir.mjs", import.meta.url)).split("\\").join("/");
  const args = ["mcp"];
  for (const r of repos) args.push("--repo", r);
  if (watch) {
    args.push("--watch");
    if (Number.isFinite(debounceMs)) args.push("--debounce", String(debounceMs));
  }
  return JSON.stringify({ gtir: { type: "stdio", command: "node", args: [gtirBin, ...args] } }, null, 2);
}
