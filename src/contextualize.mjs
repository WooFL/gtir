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

export async function contextualizeChunk(chunk, cfg) {
  // A chunk may carry a precomputed context prefix (e.g. the markdown chunker's
  // heading breadcrumb + tags). Honor it; otherwise fall back to the synthetic /
  // claude-cli prefix used for code chunks.
  const prefix = chunk.prefix ?? (cfg.contextTier === "claude-cli" ? claudeCliPrefix(chunk, cfg) : syntheticPrefix(chunk, cfg));
  return { ...chunk, embedText: `${prefix}\n${chunk.text}` };
}
