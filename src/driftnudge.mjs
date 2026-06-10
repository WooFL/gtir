// src/driftnudge.mjs — PostToolUse(Edit|Write|MultiEdit) hook logic. When the agent edits a code file
// that wiki notes document, return a factual additionalContext nudge naming those notes (so updating the
// KB is ambient, not remembered). Wiki-gated + baseline-bounded; never throws -> silent ("").
import { resolve, relative } from "node:path";
import ignore from "ignore";
import { loadConfig as realLoadConfig } from "./config.mjs";
import { reverseLinks as realReverseLinks } from "./crosslinks.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

// Drop notes the wiki excludes from drift maintenance (its `staleIgnore` globs): the write-back nudge
// must not ask the agent to reconcile archived/source notes (matches `gtir stale check`'s view filter).
// The read leg (context/notes_for) deliberately does NOT apply this — historical docs are useful context.
function dropIgnored(notes, patterns) {
  if (!patterns || !patterns.length) return notes;
  const ig = ignore().add(patterns);
  return notes.filter((n) => !ig.ignores(n.note));
}

// Pure: the nudge text from the edited path + its documenting notes.
export function formatDriftNudge(relPath, notes) {
  const names = notes.map((n) => `\`${n.note}\``).join(", ");
  return `gtir: you edited \`${relPath}\`. Wiki notes that document this code: ${names}. ` +
    `If your change altered behaviour they describe, reconcile them — update the prose, then run ` +
    `\`gtir stale sync <note>\` (or the stale_sync MCP tool). \`gtir stale check\` verifies the drift cleared.`;
}

// Resolve the documenting notes for the edited file and return the PostToolUse hook JSON, or "".
// Never throws. deps: { loadConfig?, reverseLinks? } for testing.
export async function driftnudge(inputString, { cwd = process.cwd(), deps = {} } = {}) {
  const loadConfig = deps.loadConfig || realLoadConfig;
  const reverseLinks = deps.reverseLinks || realReverseLinks;
  let parsed;
  try { parsed = JSON.parse(inputString ?? ""); } catch { return ""; }
  if (!EDIT_TOOLS.has(parsed?.tool_name)) return "";
  const file = parsed?.tool_input?.file_path;
  if (!file || typeof file !== "string") return "";
  try {
    const cfg = loadConfig(cwd);
    if (!cfg.wiki) return "";
    const rel = relative(cfg.repo, resolve(cfg.repo, file)).split(/[\\/]/).join("/");
    if (!rel || rel.startsWith("..")) return "";
    const wikiCfg = loadConfig(resolve(cfg.repo, cfg.wiki));
    const rev = await reverseLinks(wikiCfg, cfg, { baselineOnly: true });
    const notes = dropIgnored(rev.byPath.get(rel) || [], wikiCfg.staleIgnore);
    if (!notes.length) return "";
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: formatDriftNudge(rel, notes) },
    });
  } catch { return ""; }
}
