import { execFileSync } from "node:child_process";

// First non-blank line, trimmed and length-capped — usually the declaration.
function firstSignificantLine(text) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t.slice(0, 120);
  }
  return "";
}

export function syntheticPrefix(chunk, cfg) {
  // Prepend the AST scope breadcrumb (enclosing class/module names, set by the
  // chunker) to the informative first line. Additive: never drops the first line.
  // Gated by cfg.contextScope (default on); set it false to disable per-repo.
  const useScope = cfg?.contextScope !== false;
  const scope = useScope && chunk.scope?.length ? ` › ${chunk.scope.join(" › ")}` : "";
  return `${chunk.path}${scope} — ${firstSignificantLine(chunk.text)}`;
}

// Opt-in claude-cli tier; never throws (falls back to synthetic).
function claudeCliPrefix(chunk, cfg) {
  try {
    const prompt = `In one short sentence, describe what this code does. ` +
      `Reply with only the sentence.\n\nFile: ${chunk.path}\n\n${chunk.text.slice(0, 1500)}`;
    const out = execFileSync("claude", ["-p", prompt], { encoding: "utf8", timeout: 20000 });
    const line = out.trim().split("\n")[0].slice(0, 200);
    return line || syntheticPrefix(chunk, cfg);
  } catch {
    return syntheticPrefix(chunk, cfg);
  }
}

// Tokenize a path into search terms: split on separators and camelCase, lowercased.
// "auth/jwt.ts" -> "auth jwt ts"; "src/userApi.ts" -> "src user api ts".
export function pathTokens(path) {
  return String(path)
    .split(/[/\\._\-]+/)
    .flatMap((seg) => seg.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// Text handed to the BM25/FTS index. The path tokens, enclosing scope, and the
// declaration line are repeated `bm25Boost` times ahead of the body so a lexical
// match on a symbol/path outweighs an incidental mention in some other file's body
// (the shadowing case). boost = 0 falls back to indexing the raw chunk text.
export function ftsText(chunk, cfg) {
  const boost = Math.max(0, cfg?.bm25Boost ?? 0);
  if (boost === 0) return chunk.text;
  const scope = chunk.scope?.length ? chunk.scope.join(" ") : "";
  const head = `${pathTokens(chunk.path)} ${scope} ${firstSignificantLine(chunk.text)}`.replace(/\s+/g, " ").trim();
  return `${(head + "\n").repeat(boost)}${chunk.text}`;
}

export async function contextualizeChunk(chunk, cfg) {
  // A chunk may carry a precomputed context prefix (e.g. the markdown chunker's
  // heading breadcrumb + tags). Honor it; otherwise fall back to the synthetic /
  // claude-cli prefix used for code chunks.
  const prefix = chunk.prefix ?? (cfg.contextTier === "claude-cli" ? claudeCliPrefix(chunk, cfg) : syntheticPrefix(chunk, cfg));
  return { ...chunk, embedText: `${prefix}\n${chunk.text}`, ftsText: ftsText(chunk, cfg) };
}
