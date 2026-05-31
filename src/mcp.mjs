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
