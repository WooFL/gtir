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

// overrides: { [repoArg]: label }. repos: raw --repo args (loadConfig resolves them).
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
    description: "List the indexes this gtir MCP server serves, with model, dim, file count, and last-built time.",
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

// TEMPORARY stub — replaced with the real implementation in the next task.
async function dispatchToolCall() {
  return { content: [{ type: "text", text: "(not implemented)" }], isError: true };
}
