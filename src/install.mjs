// Pure helpers for `gtir install` — agent-wiring installer.
//
// Everything in this module is I/O-free: each function takes plain objects/strings
// and returns NEW objects/strings (inputs are never mutated). The file reads/writes
// live in bin/gtir.mjs's `install` subcommand. That split keeps these merge rules
// unit-testable for the core invariants: idempotency (apply twice == apply once) and
// reversibility (add then remove == the original, modulo trailing whitespace).

export const GTIR_START = "<!-- gtir:start -->";
export const GTIR_END = "<!-- gtir:end -->";

// Substring that identifies gtir's PreToolUse hook among any others: gtir's hook
// command always invokes the `hooknudge` subcommand.
export const HOOK_MATCH_KEY = "hooknudge";

// --- builders ---------------------------------------------------------------

// The `.mcp.json` server entry: run this very gtir bin as an MCP stdio server over
// the repo it's installed in (`--repo .`), live-refreshing on file changes (`--watch`).
export function gtirMcpEntry(absBinPath) {
  return { command: "node", args: [absBinPath, "mcp", "--repo", ".", "--watch"] };
}

// The PreToolUse hook entry: on Grep/Glob, run `gtir hooknudge` (reads the hook JSON
// from stdin, emits an additionalContext nudge). Forward-slash the path so the JSON
// string is valid (no `\` escapes) and the command is cross-platform — `node` accepts
// forward slashes on Windows too.
export function gtirHookEntry(absBinPath) {
  const binFwd = absBinPath.replace(/\\/g, "/");
  return {
    matcher: "Grep|Glob",
    hooks: [{ type: "command", command: `node "${binFwd}" hooknudge`, timeout: 5 }],
  };
}

// The shared nav-nudge body. FACTUAL, not imperative (per Claude Code hook guidance): state what
// the tools do and that they often beat raw Grep/Glob/Read here. Used by CLAUDE.md, AGENTS.md, and
// the Cursor rule file so all assistants advertise the same tools.
export function gtirNavBody() {
  return [
    "## Code navigation: prefer gtir's MCP tools",
    "",
    "This repo has a gtir semantic+lexical code index available over MCP. For navigating code,",
    "these usually beat raw Grep/Glob/Read:",
    "",
    "- `mcp__gtir__context` — pull a full bundle for a symbol or query (definition + source span +",
    "  callers/callees + siblings) in ONE call, instead of several Read/Grep round-trips.",
    "- `mcp__gtir__search_code` — find code by meaning (a concept, or \"where does X happen\").",
    "- `mcp__gtir__find_code` — jump to an exact symbol's definition and references.",
    "",
    "For repos paired with an Obsidian wiki, `mcp__gtir__stale_check` flags notes whose cited code drifted.",
    "",
    "Grep/Glob remain fine for exact string matches and file-name globs.",
  ].join("\n");
}

// The Cursor rule file (.cursor/rules/gtir.mdc): MDC frontmatter + the shared nav body. Cursor has
// no PreToolUse-hook equivalent, so this always-applied rule is the nudge channel. gtir owns this
// file outright (written whole on install, deleted on uninstall).
export function gtirCursorRuleBody() {
  return [
    "---",
    "description: Prefer gtir's MCP tools for code navigation in this repo.",
    "alwaysApply: true",
    "---",
    "",
    gtirNavBody(),
    "",
  ].join("\n");
}

// Treat a value as a reusable container ONLY when it's a real plain object. A config
// file is hand-edited JSON, so a key we expect to be an object can legally be the wrong
// type (e.g. `{"mcpServers":"x"}` or `{"hooks":[...]}`). Spreading a string would smear
// its characters into numeric `"0"`,`"1"`… keys; spreading an array would do likewise.
// Normalizing such a malformed value back to `{}` is safe here: we're about to (re)write
// the file anyway, and the happy path (already an object) is returned untouched.
const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v)) ? v : {};

// --- mcpServers merge --------------------------------------------------------

// Add `mcpServers[name]`, preserving every other server. Idempotent.
// When `force` is false (the default) AND `name` already exists in mcpServers, the
// existing entry is left untouched — this prevents silently downgrading a richer config
// (e.g. a multi-repo entry) to a plain default. Pass `force: true` to overwrite.
// When the name is absent, `entry` is always written regardless of `force`.
// Returns a new object on change; may return the input unchanged when preserving.
export function addMcpServer(json, name, entry, { force = false } = {}) {
  const normalized = asObject(json);
  const servers = asObject(normalized.mcpServers);
  // Preserve an existing entry when not forced: return the (possibly already-object-spread)
  // input as-is so the caller can detect no-change without a deep-equal comparison.
  if (!force && name in servers) {
    // Still return a fresh outer object in case callers spread it, but keep mcpServers intact.
    return { ...normalized, mcpServers: servers };
  }
  const out = { ...normalized };
  out.mcpServers = { ...servers, [name]: entry };
  return out;
}

// Remove `mcpServers[name]`. Leaves `mcpServers` present (possibly empty) and every
// other server intact. Idempotent; never throws on a missing key. Normalizes a malformed
// non-object `mcpServers` to `{}` rather than passing it through.
export function removeMcpServer(json, name) {
  const out = { ...asObject(json) };
  if (out.mcpServers === undefined || out.mcpServers === null) return out;
  const servers = { ...asObject(out.mcpServers) };
  delete servers[name];
  out.mcpServers = servers;
  return out;
}

// --- hooks.PreToolUse merge --------------------------------------------------

// True iff a PreToolUse entry is gtir's (any of its hook commands contains matchKey).
function isGtirHookEntry(entry, matchKey) {
  return Array.isArray(entry?.hooks)
    && entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes(matchKey));
}

// Add gtir's PreToolUse hook under `hooks.PreToolUse`, preserving other entries. If a
// gtir hook (identified by matchKey) is already present, replace it in place rather
// than appending a duplicate — so add-twice == add-once.
export function addPreToolUseHook(json, hookEntry, matchKey) {
  const out = { ...asObject(json) };
  out.hooks = { ...asObject(out.hooks) };
  const existing = Array.isArray(out.hooks.PreToolUse) ? out.hooks.PreToolUse : [];
  const others = existing.filter((e) => !isGtirHookEntry(e, matchKey));
  out.hooks.PreToolUse = [...others, hookEntry];
  return out;
}

// Remove gtir's PreToolUse hook (entries whose command contains matchKey), keeping all
// others. Leaves `hooks.PreToolUse` present (possibly empty). Idempotent. Normalizes a
// malformed non-object `hooks` / non-array `hooks.PreToolUse` rather than passing it through.
export function removePreToolUseHook(json, matchKey) {
  const out = { ...asObject(json) };
  if (out.hooks === undefined || out.hooks === null) return out;
  const hooks = { ...asObject(out.hooks) };
  if (hooks.PreToolUse === undefined || hooks.PreToolUse === null) { out.hooks = hooks; return out; }
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  hooks.PreToolUse = existing.filter((e) => !isGtirHookEntry(e, matchKey));
  out.hooks = hooks;
  return out;
}

// --- CLAUDE.md marked section ------------------------------------------------

// Generic marked-section helpers now live in their own module; re-exported for back-compat
// (install + its tests import them from here).
export { upsertMarkedSection, removeMarkedSection } from "./marked-section.mjs";

// --- verify predicates (pure; the CLI feeds them parsed file contents) ------

// True iff `json` has a gtir server under a well-formed `mcpServers` object.
export function mcpHasGtir(json) {
  const s = json?.mcpServers;
  return !!(s && typeof s === "object" && !Array.isArray(s) && s.gtir);
}

// True iff `json` has a PreToolUse entry whose command contains gtir's hook key.
export function settingsHasHook(json) {
  const arr = json?.hooks?.PreToolUse;
  return Array.isArray(arr) && arr.some((e) =>
    Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && h.command.includes(HOOK_MATCH_KEY)));
}

// True iff `text` contains gtir's marked section (both fences).
export function markedSectionPresent(text) {
  return typeof text === "string" && text.includes(GTIR_START) && text.includes(GTIR_END);
}

// --- hooknudge handler (pure; the CLI feeds it stdin) -----------------------

// Factual nudge text surfaced to the agent when it reaches for Grep/Glob.
export const HOOKNUDGE_TEXT =
  "gtir MCP is available in this repo: mcp__gtir__context bundles a symbol's definition + source "
  + "+ callers/callees in one call; mcp__gtir__search_code finds code by meaning; mcp__gtir__find_code "
  + "jumps to a symbol's definition/references. They often beat raw Grep/Glob for navigating this codebase.";

// Given the raw PreToolUse hook JSON (as a string), return the stdout the hook should
// print: an additionalContext nudge for Grep/Glob, otherwise "" (no output). Never
// throws — malformed/empty input yields "" so the hook can exit 0 silently.
export function hooknudge(inputString) {
  let parsed;
  try {
    parsed = JSON.parse(inputString ?? "");
  } catch {
    return "";
  }
  const tool = parsed?.tool_name;
  if (tool !== "Grep" && tool !== "Glob") return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: HOOKNUDGE_TEXT,
    },
  });
}
