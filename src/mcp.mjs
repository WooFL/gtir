import { resolve, basename } from "node:path";
import { loadConfig } from "./config.mjs";
import { search } from "./search.mjs";
import { openStore } from "./store.mjs";

export function sanitizeLabel(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "index";
}

export function deriveLabel(repo, cfg, override) {
  if (override) return sanitizeLabel(override);
  const m = cfg?.model || "";
  if (/nomic/i.test(m)) return "notes";
  if (/jina.*code/i.test(m)) return "code";
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
  const tools = indexes.map((ix) => ({
    name: `search_${ix.label}`,
    description: `Hybrid semantic + lexical (vector + BM25 + RRF) search over the ${ix.label} index at ${ix.repo}. Returns ranked chunks.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "natural-language search query" },
        k: { type: "integer", description: "max results (default 8)" },
        path_prefix: { type: "string", description: "restrict to paths under this prefix" },
        language: { type: "string", description: "restrict to a language (code indexes)" },
      },
      required: ["query"],
    },
  }));
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

function formatHits(results) {
  if (!results.length) return "(no matches)";
  return results.map((r) => {
    const branch = [r.vec_rank ? `v${r.vec_rank}` : null, r.fts_rank ? `f${r.fts_rank}` : null].filter(Boolean).join("+") || "—";
    return `### ${r.path}:${r.lines}  _(rrf=${r.score} · ${branch})_\n\`\`\`\n${r.snippet}\n\`\`\``;
  }).join("\n\n");
}

async function dispatchToolCall(params, ctx) {
  const { indexes, searchFn, statusFn } = ctx;
  const name = params.name;
  const args = params.arguments ?? {};
  try {
    if (name === "gtir_status") {
      const status = await statusFn();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], structuredContent: { indexes: status } };
    }
    if (typeof name === "string" && name.startsWith("search_")) {
      const label = name.slice("search_".length);
      if (!indexes.some((ix) => ix.label === label)) {
        return { content: [{ type: "text", text: `unknown index: ${label}` }], isError: true };
      }
      const results = await searchFn(label, {
        query: args.query, k: args.k, pathPrefix: args.path_prefix, language: args.language,
      });
      return { content: [{ type: "text", text: formatHits(results) }], structuredContent: { results } };
    }
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
}
