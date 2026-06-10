import { resolve, basename, relative } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { search } from "./search.mjs";
import { openStore } from "./store.mjs";
import { preflight } from "./doctor.mjs";
import { parseLines } from "./eval.mjs";
import { watchRepo } from "./watch.mjs";
import { buildAdjacency, callersOf, calleesOf, neighborsOf } from "./edges.mjs";
import { impactQuery, orphansQuery, cyclesQuery, pathQuery, graphForSearch, clearGraphCache } from "./graph-queries.mjs";
import { contextFor } from "./graph-retrieval.mjs";
import { buildContext } from "./context.mjs";
import { checkQuery as staleCheckQuery, ackQuery as staleAckQuery, syncQuery as staleSyncQuery } from "./stale-run.mjs";
import { reverseLinks, notesFor } from "./crosslinks.mjs";

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
      name: `context_${ix.label}`,
      description: `Task-shaped: get complete context for ${at} in ONE call. Pass a "query" (searches, then ` +
        `attaches each top hit's source + callers/callees) OR "targets" (symbol names and/or "path:lines" spans, ` +
        `each returned with source + callers/callees + siblings). Includes a retrieval_quality (high/medium/low) ` +
        `and best_guesses flag. Prefer this over separate search+read+callers calls — it saves round-trips.` +
        ` When a wiki is paired, each item also carries "notes" — the wiki notes documenting that code.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "natural-language query (query mode)" },
          targets: { type: "array", items: { type: "string" }, description: 'symbol names or "path:lines" spans (targets mode)' },
          k: { type: "integer", description: "query-mode result count (default 5)" },
          context: { type: "integer", description: "extra source lines around each span (0-50)" },
        },
      },
    });
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
          centrality: { type: "boolean", description: "gently re-rank by call-graph degree (important code floats up)" },
          edges: { type: "boolean", description: "attach each hit's callers/callees (graph neighborhood)" },
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
          edges: { type: "boolean", description: "attach the span's callers/callees" },
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
    const noteMode = /nomic|notes/i.test(ix.label) || /nomic/i.test(ix.cfg?.model || "");
    const callersName = noteMode ? `backlinks_${ix.label}` : `callers_${ix.label}`;
    const calleesName = noteMode ? `links_${ix.label}` : `callees_${ix.label}`;
    tools.push({
      name: callersName,
      description: noteMode
        ? `Notes that link to a note in ${at} (backlinks). Pass the note name.`
        : `Spans that call a symbol in ${at}. Real call edges (not lexical) — each tagged resolved/ambiguous.`,
      inputSchema: { type: "object", properties: {
        symbol: { type: "string", description: "exact symbol or note name" },
        limit: { type: "integer", description: "max results (default 50)" },
      }, required: ["symbol"] },
    });
    tools.push({
      name: calleesName,
      description: noteMode
        ? `Notes/embeds a note links to in ${at}. Pass the note name.`
        : `What a symbol calls in ${at} (outgoing call edges).`,
      inputSchema: { type: "object", properties: {
        symbol: { type: "string", description: "exact symbol or note name" },
        limit: { type: "integer", description: "max results (default 50)" },
      }, required: ["symbol"] },
    });
    tools.push({
      name: `neighbors_${ix.label}`,
      description: `Blast radius around a span in ${at}: callers + callees + same-file siblings. Returns file:line.`,
      inputSchema: { type: "object", properties: {
        symbol: { type: "string", description: "the span's symbol name (drives caller/callee lookup)" },
        path: { type: "string", description: "file path of the span" },
        lines: { type: "string", description: 'line range of the span, e.g. "48-79"' },
      }, required: ["symbol"] },
    });
    tools.push({
      name: `impact_${ix.label}`,
      description: noteMode
        ? `Transitive backlinks of a note in ${at} — everything that (transitively) links to it.`
        : `Transitive blast radius in ${at}: who (transitively) calls a symbol. downstream:true returns what it depends on instead. Resolved edges only unless include_ambiguous.`,
      inputSchema: { type: "object", properties: {
        symbol: { type: "string", description: "exact symbol or note name" },
        path: { type: "string", description: "file path to disambiguate a symbol defined in multiple files" },
        downstream: { type: "boolean", description: "walk dependencies (callees) instead of callers" },
        depth: { type: "integer", description: "max hops (default unlimited)" },
        include_ambiguous: { type: "boolean", description: "also traverse ambiguous (name-coincidence) edges" },
        limit: { type: "integer", description: "max nodes returned (default 500)" },
      }, required: ["symbol"] },
    });
    tools.push({
      name: `orphans_${ix.label}`,
      description: noteMode
        ? `Notes in ${at} with no backlinks (candidates for orphaned notes).`
        : `Likely-dead callable symbols in ${at}: functions/classes/methods with NO inbound reference (resolved, inferred, or ambiguous). Local variables, types, and entrypoints are excluded.`,
      inputSchema: { type: "object", properties: {} },
    });
    tools.push({
      name: `cycles_${ix.label}`,
      description: `Circular dependencies in ${at}: call cycles + import cycles (SCC groups with a sample path).`,
      inputSchema: { type: "object", properties: {
        include_ambiguous: { type: "boolean", description: "include ambiguous edges in cycle detection" },
      } },
    });
    tools.push({
      name: `path_${ix.label}`,
      description: noteMode
        ? `Shortest link-path from one note to another in ${at}.`
        : `Shortest call-path from one symbol to another in ${at}.`,
      inputSchema: { type: "object", properties: {
        from: { type: "string", description: "source symbol (or note) name" },
        to: { type: "string", description: "destination symbol (or note) name" },
        from_path: { type: "string", description: "file path substring to disambiguate the 'from' symbol" },
        to_path: { type: "string", description: "file path substring to disambiguate the 'to' symbol" },
        depth: { type: "integer", description: "max hops (default unlimited)" },
        include_ambiguous: { type: "boolean", description: "also traverse ambiguous (name-coincidence) edges" },
      }, required: ["from", "to"] },
    });
  }
  tools.push({
    name: "gtir_status",
    description: "List the indexes this gtir MCP server serves, with model, dim, file/chunk count, and last-built time.",
    inputSchema: { type: "object", properties: {} },
  });
  tools.push({
    name: "stale_check",
    description: "After changing code, list wiki notes whose cited code has drifted (signature/body/removed). " +
      "Returns each stale note + symbol + severity + before/now. Reconcile each note, then call stale_ack. " +
      "Requires both a notes index and a code index to be served.",
    inputSchema: { type: "object", properties: { note: { type: "string", description: "scope to one note path (optional)" } } },
  });
  tools.push({
    name: "stale_ack",
    description: "Re-baseline a wiki note after you reconciled it to current code, so the same drift stops flagging.",
    inputSchema: { type: "object", properties: { note: { type: "string", description: "the note path to re-baseline" } }, required: ["note"] },
  });
  tools.push({
    name: "stale_sync",
    description: "After writing code AND updating note prose, deterministically refresh gtir-managed refs " +
      "blocks + stale flags in wiki notes. Returns which symbols were auto-acked (signature shown in the " +
      "table) vs still need prose review (body/removed). Use init to seed a refs block into a note. " +
      "Requires both a notes index and a code index.",
    inputSchema: { type: "object", properties: {
      note: { type: "string", description: "scope init to one note path (optional)" },
      init: { type: "boolean", description: "seed a refs block into note(s) lacking one" },
      all: { type: "boolean", description: "with init: seed every code-citing note" },
    } },
  });
  tools.push({
    name: "notes_for",
    description: "Wiki notes that document a piece of code — pass a symbol name and/or a repo-relative path. " +
      "The read half of the code↔notes loop: what the knowledge base already says about this code before you change it. " +
      "Returns { notes: [{ note, lines?, snippet? }] }. Empty when no wiki+code pair is served.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "code symbol name" },
        path: { type: "string", description: "repo-relative file path" },
      },
    },
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

// declaredSymbols is defined in symbols.mjs (separate module to avoid circular imports through
// watch.mjs → indexer.mjs → mcp.mjs). Re-exported here so existing importers still work.
export { declaredSymbols } from "./symbols.mjs";

function formatFind(results, symbol, kind) {
  if (!results.length) return `(no ${kind} found for "${symbol}")`;
  return results.map((r) => {
    if (!r.snippet) return `### ${r.path}:${r.lines}  _(${r.kind})_`;
    return `### ${r.path}:${r.lines}  _(${r.kind})_\n\`\`\`\n${r.snippet}\n\`\`\``;
  }).join("\n\n");
}

const TOOL_VERBS = ["search", "read", "outline", "similar", "find", "callers", "callees", "neighbors", "backlinks", "links", "impact", "orphans", "cycles", "path", "context"];

// "search_my_wiki" -> { verb: "search", label: "my_wiki" } (labels may contain underscores).
export function parseToolName(name) {
  for (const v of TOOL_VERBS) {
    if (typeof name === "string" && name.startsWith(v + "_")) return { verb: v, label: name.slice(v.length + 1) };
  }
  return null;
}

const stripSnippet = (results) => results.map(({ snippet, ...rest }) => rest);

export async function dispatchToolCall(params, ctx) {
  const { indexes, searchFn, statusFn, readFn, outlineFn, similarFn, findFn, callersFn, calleesFn, neighborsFn, impactFn, orphansFn, cyclesFn, pathFn, contextFn } = ctx;
  const name = params.name;
  const args = params.arguments ?? {};
  const reply = (text, structured) => ({ content: [{ type: "text", text }], structuredContent: structured });
  try {
    if (name === "gtir_status") {
      const status = await statusFn();
      return reply(JSON.stringify(status, null, 2), { indexes: status });
    }
    if (name === "stale_check") {
      const out = await ctx.staleCheckFn(args);
      if (out.error) return { content: [{ type: "text", text: out.error }], isError: true };
      return reply(JSON.stringify(out, null, 2), out);
    }
    if (name === "stale_ack") {
      const out = await ctx.staleAckFn(args.note);
      if (out.error) return { content: [{ type: "text", text: out.error }], isError: true };
      return reply(JSON.stringify(out, null, 2), out);
    }
    if (name === "stale_sync") {
      const out = await ctx.staleSyncFn(args);
      if (out.error) return { content: [{ type: "text", text: out.error }], isError: true };
      return reply(JSON.stringify(out, null, 2), out);
    }
    if (name === "notes_for") {
      const out = await ctx.notesForFn(args);
      return reply(JSON.stringify(out, null, 2), out);
    }
    const parsed = parseToolName(name);
    if (parsed) {
      const { verb, label } = parsed;
      if (!indexes.some((ix) => ix.label === label)) {
        return { content: [{ type: "text", text: `unknown index: ${label}` }], isError: true };
      }
      if (verb === "search") {
        let results = await searchFn(label, { query: args.query, k: args.k, pathPrefix: args.path_prefix, language: args.language, centrality: !!args.centrality, edges: !!args.edges });
        if (args.compact) results = stripSnippet(results);
        return reply(args.compact ? formatCompact(results) : formatHits(results), { results });
      }
      if (verb === "context") {
        const out = await contextFn(label, { query: args.query, targets: args.targets, k: args.k, context: args.context });
        return reply(JSON.stringify(out, null, 2), out);
      }
      if (verb === "read") {
        const out = await readFn(label, { path: args.path, lines: args.lines, context: args.context, edges: !!args.edges });
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
      if (verb === "callers" || verb === "backlinks") {
        const results = await callersFn(label, { symbol: args.symbol, limit: args.limit });
        return reply(JSON.stringify(results, null, 2), { results });
      }
      if (verb === "callees" || verb === "links") {
        const results = await calleesFn(label, { symbol: args.symbol, limit: args.limit });
        return reply(JSON.stringify(results, null, 2), { results });
      }
      if (verb === "neighbors") {
        const out = await neighborsFn(label, { symbol: args.symbol, path: args.path, lines: args.lines });
        return reply(JSON.stringify(out, null, 2), out);
      }
      if (verb === "impact") {
        const out = await impactFn(label, { symbol: args.symbol, path: args.path, downstream: !!args.downstream,
          depth: args.depth, includeAmbiguous: !!args.include_ambiguous, limit: args.limit });
        return reply(JSON.stringify(out, null, 2), out);
      }
      if (verb === "orphans") {
        const out = await orphansFn(label, {});
        return reply(JSON.stringify(out, null, 2), out);
      }
      if (verb === "cycles") {
        const out = await cyclesFn(label, { includeAmbiguous: !!args.include_ambiguous });
        return reply(JSON.stringify(out, null, 2), out);
      }
      if (verb === "path") {
        const out = await pathFn(label, { from: args.from, to: args.to, fromPath: args.from_path, toPath: args.to_path, depth: args.depth, includeAmbiguous: !!args.include_ambiguous });
        return reply(JSON.stringify(out, null, 2), out);
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
    const graphData = (args.centrality || args.edges) ? await graphForSearch(ix.cfg) : null;
    return search(args.query, ix.cfg, { k: args.k, pathPrefix: args.pathPrefix, language: args.language,
      centrality: !!args.centrality, edges: !!args.edges, graphData });
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
  return async (label, { path, lines = null, context = 3, edges = false }) => {
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
    const out = { path, lines: `${start}-${end}`, language: ix.cfg?.language ?? null, text: body.slice(start - 1, end).join("\n") };
    if (edges) {
      const { graph } = await graphForSearch(ix.cfg);
      return { ...out, ...contextFor(out.text, out.path, graph, { cap: ix.cfg.contextCap ?? 5 }) };
    }
    return out;
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
    if (kind === "references") {
      const adj = await adjacencyFor(ix).catch(() => null);
      const edgeCallers = adj ? callersOf(adj, symbol) : [];
      if (edgeCallers.length) {
        return edgeCallers.slice(0, k).map((c) => ({
          path: c.path, lines: c.lines, language: null, kind: "reference", conf: c.conf, snippet: "",
        }));
      }
      // fall through to the existing lexical sweep below
    }
    const rows = (kind === "references" ? cand.filter((r) => word.test(r.text)) : cand.filter(isDef)).slice(0, k);
    return rows.map((r) => ({
      path: r.path, lines: `${r.line_start}-${r.line_end}`, language: r.language,
      kind: isDef(r) ? "definition" : "reference", snippet: r.text,
    }));
  };
}

const adjCache = new Map(); // repo path -> adj

async function adjacencyFor(ix) {
  const cacheKey = ix.repo;
  if (adjCache.has(cacheKey)) return adjCache.get(cacheKey);
  const store = await openStore(ix.cfg);
  const rows = await store.loadEdges();
  const adj = buildAdjacency(rows);
  adjCache.set(cacheKey, adj);
  return adj;
}

export function defaultCallersFn(indexes) {
  return async (label, { symbol, limit = 50 }) => {
    const ix = indexes.find((i) => i.label === label);
    if (!symbol) throw new Error("symbol is required");
    const adj = await adjacencyFor(ix);
    return callersOf(adj, symbol).slice(0, Math.max(1, Math.min(200, limit | 0 || 50)));
  };
}

export function defaultCalleesFn(indexes) {
  return async (label, { symbol, limit = 50 }) => {
    const ix = indexes.find((i) => i.label === label);
    if (!symbol) throw new Error("symbol is required");
    const adj = await adjacencyFor(ix);
    return calleesOf(adj, symbol).slice(0, Math.max(1, Math.min(200, limit | 0 || 50)));
  };
}

export function defaultNeighborsFn(indexes) {
  return async (label, { symbol, path = null, lines = null }) => {
    const ix = indexes.find((i) => i.label === label);
    if (!symbol) throw new Error("symbol is required");
    const adj = await adjacencyFor(ix);
    let siblings = [];
    if (path) {
      const store = await openStore(ix.cfg);
      siblings = (await store.chunksByPath(path)).map((r) => ({
        line_start: Number(r.line_start), line_end: Number(r.line_end), signature: signatureOf(r.text),
      }));
    }
    return neighborsOf(adj, { symbol, path, lines, siblings });
  };
}

// Pick the notes (wiki) index and the code index from the served set. If more than one code index is
// served, the FIRST is used (stale tools are single-pair); ambiguity is not currently surfaced.
export function findWikiAndCode(indexes) {
  const isNotes = (ix) => /nomic|notes/i.test(ix.label) || /nomic/i.test(ix.cfg?.model || "");
  const wiki = indexes.find(isNotes);
  const code = indexes.find((ix) => !isNotes(ix));
  return { wiki, code };
}

// Narrow a drift report to a single note (used by the stale_check `note` arg).
export function filterReportToNote(report, note) {
  if (report.error || !note) return report;
  const stale = report.stale.filter((s) => s.note === note);
  return { ...report, stale, staleNotes: stale.length, staleLinks: stale.reduce((n, s) => n + s.rows.length, 0) };
}

export function defaultStaleCheckFn(indexes) {
  return async (args = {}) => {
    const { wiki, code } = findWikiAndCode(indexes);
    if (!wiki) return { error: "stale needs a notes index — configure a notes (wiki) repo" };
    if (!code) return { error: "stale needs a code index — configure a code repo to link the notes to" };
    const report = await staleCheckQuery(wiki.cfg, code.cfg);
    return filterReportToNote(report, args && args.note);
  };
}
export function defaultStaleAckFn(indexes) {
  return async (note) => {
    const { wiki, code } = findWikiAndCode(indexes);
    if (!wiki) return { error: "stale needs a notes index — configure a notes (wiki) repo" };
    if (!code) return { error: "stale needs a code index — configure a code repo to link the notes to" };
    if (!note) return { error: "note is required" };
    return staleAckQuery(wiki.cfg, code.cfg, note);
  };
}
export function defaultStaleSyncFn(indexes) {
  return async (args = {}) => {
    const { wiki, code } = findWikiAndCode(indexes);
    if (!wiki) return { error: "stale needs a notes index — configure a notes (wiki) repo" };
    if (!code) return { error: "stale needs a code index — configure a code repo to link the notes to" };
    let sha = "unknown";
    try { sha = execFileSync("git", ["-C", code.cfg.repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* leave "unknown" */ }
    return staleSyncQuery(wiki.cfg, code.cfg, { sha, init: !!args.init, all: !!args.all, notePath: args.note || null });
  };
}

export function defaultImpactFn(indexes) {
  return async (label, opts) => {
    const ix = indexes.find((i) => i.label === label);
    if (!ix) throw new Error(`unknown index: ${label}`);
    return impactQuery(ix.cfg, opts);
  };
}
export function defaultOrphansFn(indexes) {
  return async (label) => {
    const ix = indexes.find((i) => i.label === label);
    if (!ix) throw new Error(`unknown index: ${label}`);
    return orphansQuery(ix.cfg);
  };
}
export function defaultCyclesFn(indexes) {
  return async (label, opts) => {
    const ix = indexes.find((i) => i.label === label);
    if (!ix) throw new Error(`unknown index: ${label}`);
    return cyclesQuery(ix.cfg, opts);
  };
}
export function defaultPathFn(indexes) {
  return async (label, opts) => {
    const ix = indexes.find((i) => i.label === label);
    if (!ix) throw new Error(`unknown index: ${label}`);
    return pathQuery(ix.cfg, opts);
  };
}

export function defaultContextFn(indexes) {
  return async (label, args) => {
    const ix = indexes.find((i) => i.label === label);
    if (!ix) throw new Error(`unknown index: ${label}`);
    // Attach related notes only when THIS index is the code side of a wiki↔code pair on this server.
    const { wiki, code } = findWikiAndCode(indexes);
    const paired = wiki && code && ix.label === code.label ? { wikiCfg: wiki.cfg, codeCfg: code.cfg } : null;
    return buildContext(ix.cfg, { query: args.query, targets: args.targets, k: args.k, contextLines: args.context, wiki: paired });
  };
}

export function defaultNotesForFn(indexes) {
  return async (args = {}) => {
    const { wiki, code } = findWikiAndCode(indexes);
    if (!wiki || !code) return { notes: [] };
    const rev = await reverseLinks(wiki.cfg, code.cfg);
    const cap = code.cfg.relatedNotesCap ?? 8;
    return { notes: notesFor(rev, { symbol: args.symbol || null, path: args.path || null }, cap) };
  };
}

// Gate each served index on a readiness probe before serving. A broken/unready index is dropped
// with a logged note (stderr) — the healthy ones still serve, matching defaultStatusFn's per-index
// tolerance. The server must not refuse to start because one index's daemon/model is unready.
// Indexes whose cfg disables warmupOnStart (or injects a non-Ollama backend) skip the probe and
// are kept as-is — the embed retry layer covers them at query time.
export async function preflightIndexes(indexes, { log = () => {} } = {}) {
  const healthy = [];
  // Serial, not Promise.all: avoids a thundering-herd of probes on a cold Ollama daemon at startup.
  for (const ix of indexes) {
    if (!ix.cfg.warmupOnStart || ix.cfg.embedImpl) { healthy.push(ix); continue; }
    try { await preflight(ix.cfg); healthy.push(ix); }
    catch (e) { log(`index '${ix.label}' not ready — skipping (${String(e.message).split("\n").pop()})`); }
  }
  return healthy;
}

export function serveStdio(indexes, { version } = {}) {
  const ctx = {
    indexes, version,
    searchFn: defaultSearchFn(indexes), statusFn: defaultStatusFn(indexes),
    readFn: defaultReadFn(indexes), outlineFn: defaultOutlineFn(indexes),
    similarFn: defaultSimilarFn(indexes), findFn: defaultFindFn(indexes),
    callersFn: defaultCallersFn(indexes), calleesFn: defaultCalleesFn(indexes),
    neighborsFn: defaultNeighborsFn(indexes),
    impactFn: defaultImpactFn(indexes), orphansFn: defaultOrphansFn(indexes), cyclesFn: defaultCyclesFn(indexes),
    pathFn: defaultPathFn(indexes),
    contextFn: defaultContextFn(indexes),
    staleCheckFn: defaultStaleCheckFn(indexes),
    staleAckFn: defaultStaleAckFn(indexes),
    staleSyncFn: defaultStaleSyncFn(indexes),
    notesForFn: defaultNotesForFn(indexes),
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
  process.stderr.write(`gtir mcp: serving [${indexes.map((i) => i.label).join(", ")}] × {search,context,read,outline,similar,find,callers,callees,neighbors,impact,orphans,cycles,path} + gtir_status\n`);
}

// Start a live file-watcher per served index (`gtir mcp --watch`). Each watcher runs an
// incremental refresh on a debounced batch of changes and defers during git operations (the
// same gitBusy gate as the commit hooks), so the index the agent queries tracks the working
// tree as you edit — no commit required. `log` MUST route to stderr; stdout is the JSON-RPC
// channel and any stray write corrupts the protocol. Returns the handles so callers can close them.
export function startWatchers(indexes, { debounceMs = 1500, sweepMs, log = () => {} } = {}) {
  return indexes.map((ix) => {
    const handle = watchRepo(ix.cfg, {
      debounceMs, sweepMs, log: (m) => log(`[${ix.label}] ${m}`),
      onBatch: async (paths) => {
        const { buildIndex } = await import("./indexer.mjs");
        try {
          const r = await buildIndex(ix.cfg, { rebuild: false, paths });
          adjCache.delete(ix.repo); // invalidate adjacency cache after any refresh
          clearGraphCache(ix.cfg.indexDir); // and the centrality/edges graph cache (parity with adjCache)
          if (r && (r.chunks > 0 || r.evicted > 0)) {
            log(`[${ix.label}] refreshed — ${r.chunks} chunks (${r.embedded} embedded, ${r.reused} reused, ${r.skipped} skipped, ${r.evicted} evicted)`);
          }
          return r;
        } catch (e) {
          log(`[${ix.label}] refresh failed — ${e.message} (will retry on next change)`);
        }
      },
    });
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
