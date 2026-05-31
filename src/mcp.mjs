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
