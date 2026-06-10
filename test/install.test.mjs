import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  gtirMcpEntry,
  gtirHookEntry,
  gtirNavBody,
  gtirCursorRuleBody,
  addMcpServer,
  removeMcpServer,
  addPreToolUseHook,
  removePreToolUseHook,
  upsertMarkedSection,
  removeMarkedSection,
  hooknudge,
  mcpHasGtir,
  settingsHasHook,
  markedSectionPresent,
  GTIR_START,
  GTIR_END,
  HOOK_MATCH_KEY,
} from "../src/install.mjs";
import { runInstall } from "../bin/gtir.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "gtir-install-"));
// The absolute path to the real bin/gtir.mjs (what runInstall resolves at runtime).
const BIN = fileURLToPath(new URL("../bin/gtir.mjs", import.meta.url));

// --- builders ---------------------------------------------------------------

test("gtirMcpEntry: node + [bin, mcp, --repo, ., --watch]", () => {
  const e = gtirMcpEntry("/abs/bin/gtir.mjs");
  assert.equal(e.command, "node");
  assert.deepEqual(e.args, ["/abs/bin/gtir.mjs", "mcp", "--repo", ".", "--watch"]);
});

test("gtirHookEntry: Grep|Glob matcher, command contains hooknudge, forward-slashed path", () => {
  const e = gtirHookEntry("C:\\abs\\bin\\gtir.mjs");
  assert.equal(e.matcher, "Grep|Glob");
  assert.equal(e.hooks.length, 1);
  const h = e.hooks[0];
  assert.equal(h.type, "command");
  assert.equal(h.timeout, 5);
  assert.match(h.command, /hooknudge/);
  // Windows backslashes must be forward-slashed so the JSON string is valid + cross-platform.
  assert.ok(!h.command.includes("\\"), "command must not contain backslashes");
  assert.equal(h.command, 'node "C:/abs/bin/gtir.mjs" hooknudge');
});

test("gtirNavBody: factual nudge naming context + both search tools", () => {
  const body = gtirNavBody();
  assert.match(body, /mcp__gtir__context/);
  assert.match(body, /mcp__gtir__search_code/);
  assert.match(body, /mcp__gtir__find_code/);
  assert.match(body, /Grep/);
  assert.match(body, /Glob/);
});

test("gtirCursorRuleBody: MDC frontmatter + nav body", () => {
  const out = gtirCursorRuleBody();
  // Frontmatter block at the top
  assert.match(out, /^---\n/);
  assert.match(out, /description: .+/);
  assert.match(out, /alwaysApply: true/);
  // Closing frontmatter fence then the shared nav body
  assert.ok(out.includes("\n---\n"), "frontmatter is closed");
  assert.match(out, /mcp__gtir__context/);
  assert.match(out, /mcp__gtir__search_code/);
});

// --- addMcpServer / removeMcpServer ----------------------------------------

test("addMcpServer: empty json gets gtir under mcpServers", () => {
  const out = addMcpServer({}, "gtir", gtirMcpEntry(BIN));
  assert.deepEqual(out.mcpServers.gtir, gtirMcpEntry(BIN));
});

test("addMcpServer: preserves other servers; does not mutate input", () => {
  const input = { mcpServers: { other: { command: "x", args: ["y"] } } };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = addMcpServer(input, "gtir", gtirMcpEntry(BIN));
  assert.deepEqual(out.mcpServers.other, { command: "x", args: ["y"] });
  assert.ok(out.mcpServers.gtir);
  assert.deepEqual(input, snapshot, "input must not be mutated");
});

test("addMcpServer: idempotent — add twice equals add once", () => {
  const once = addMcpServer({}, "gtir", gtirMcpEntry(BIN));
  const twice = addMcpServer(once, "gtir", gtirMcpEntry(BIN));
  assert.deepEqual(twice, once);
});

test("removeMcpServer: removes gtir, keeps others; idempotent; round-trips to original", () => {
  const original = { mcpServers: { other: { command: "x", args: [] } } };
  const added = addMcpServer(original, "gtir", gtirMcpEntry(BIN));
  const removed = removeMcpServer(added, "gtir");
  assert.deepEqual(removed, original, "add then remove == original");
  // idempotent removal
  assert.deepEqual(removeMcpServer(removed, "gtir"), removed);
  // removing the only server leaves mcpServers present but empty (never deletes file content here)
  const onlyGtir = addMcpServer({}, "gtir", gtirMcpEntry(BIN));
  const empty = removeMcpServer(onlyGtir, "gtir");
  assert.deepEqual(empty.mcpServers, {});
});

// --- addPreToolUseHook / removePreToolUseHook ------------------------------

test("addPreToolUseHook: empty json gets hooks.PreToolUse with the gtir entry", () => {
  const out = addPreToolUseHook({}, gtirHookEntry(BIN), HOOK_MATCH_KEY);
  assert.equal(out.hooks.PreToolUse.length, 1);
  assert.match(out.hooks.PreToolUse[0].hooks[0].command, /hooknudge/);
});

test("addPreToolUseHook: preserves an existing unrelated PreToolUse entry; no mutation", () => {
  const input = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = addPreToolUseHook(input, gtirHookEntry(BIN), HOOK_MATCH_KEY);
  assert.equal(out.hooks.PreToolUse.length, 2);
  assert.ok(out.hooks.PreToolUse.some((e) => e.matcher === "Bash"));
  assert.ok(out.hooks.PreToolUse.some((e) => e.hooks.some((h) => /hooknudge/.test(h.command))));
  assert.deepEqual(input, snapshot, "input must not be mutated");
});

test("addPreToolUseHook: idempotent — add twice does not duplicate the gtir hook", () => {
  const once = addPreToolUseHook({}, gtirHookEntry(BIN), HOOK_MATCH_KEY);
  const twice = addPreToolUseHook(once, gtirHookEntry(BIN), HOOK_MATCH_KEY);
  assert.deepEqual(twice, once);
  const gtirEntries = twice.hooks.PreToolUse.filter((e) => e.hooks.some((h) => /hooknudge/.test(h.command)));
  assert.equal(gtirEntries.length, 1);
});

test("removePreToolUseHook: removes only the gtir entry; keeps others; round-trips", () => {
  const original = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } };
  const added = addPreToolUseHook(original, gtirHookEntry(BIN), HOOK_MATCH_KEY);
  const removed = removePreToolUseHook(added, HOOK_MATCH_KEY);
  assert.deepEqual(removed, original, "add then remove == original");
  // idempotent
  assert.deepEqual(removePreToolUseHook(removed, HOOK_MATCH_KEY), removed);
});

test("removePreToolUseHook: removing the only hook leaves PreToolUse empty (file not deleted)", () => {
  const onlyGtir = addPreToolUseHook({}, gtirHookEntry(BIN), HOOK_MATCH_KEY);
  const empty = removePreToolUseHook(onlyGtir, HOOK_MATCH_KEY);
  assert.deepEqual(empty.hooks.PreToolUse, []);
});

// --- type guards: malformed (wrong-type but valid JSON) pre-existing values -----
// A hand-edited config can have the right key with the WRONG type. Spreading a string
// would smear it into numeric "0","1"… keys; we must normalize, never corrupt.

test("addMcpServer: mcpServers is a string => normalized to an object with only gtir (no numeric keys)", () => {
  const out = addMcpServer({ mcpServers: "x" }, "gtir", gtirMcpEntry(BIN));
  assert.equal(typeof out.mcpServers, "object");
  assert.ok(!Array.isArray(out.mcpServers));
  assert.deepEqual(out.mcpServers.gtir, gtirMcpEntry(BIN));
  assert.deepEqual(Object.keys(out.mcpServers), ["gtir"], "no smeared numeric keys");
  assert.ok(!("0" in out.mcpServers), "string was not spread into index keys");
});

test("addMcpServer: top-level json is an array => normalized, gtir present", () => {
  const out = addMcpServer(["nope"], "gtir", gtirMcpEntry(BIN));
  assert.ok(!Array.isArray(out));
  assert.deepEqual(out.mcpServers.gtir, gtirMcpEntry(BIN));
});

test("removeMcpServer: mcpServers is a string => normalized to {} (not smeared)", () => {
  const out = removeMcpServer({ mcpServers: "x" }, "gtir");
  assert.deepEqual(out.mcpServers, {});
});

test("addPreToolUseHook: hooks is a string => normalized to an object with a valid PreToolUse array", () => {
  const out = addPreToolUseHook({ hooks: "y" }, gtirHookEntry(BIN), HOOK_MATCH_KEY);
  assert.equal(typeof out.hooks, "object");
  assert.ok(!Array.isArray(out.hooks));
  assert.ok(Array.isArray(out.hooks.PreToolUse));
  assert.equal(out.hooks.PreToolUse.length, 1);
  assert.match(out.hooks.PreToolUse[0].hooks[0].command, /hooknudge/);
  assert.ok(!("0" in out.hooks), "string was not spread into index keys");
});

test("addPreToolUseHook: hooks.PreToolUse is a string => coerced to [] then gtir appended", () => {
  const out = addPreToolUseHook({ hooks: { PreToolUse: "z" } }, gtirHookEntry(BIN), HOOK_MATCH_KEY);
  assert.ok(Array.isArray(out.hooks.PreToolUse));
  assert.equal(out.hooks.PreToolUse.length, 1, "non-array PreToolUse coerced to [] before append");
  assert.match(out.hooks.PreToolUse[0].hooks[0].command, /hooknudge/);
});

test("removePreToolUseHook: hooks is a string => normalized to {} (no PreToolUse fabricated)", () => {
  const out = removePreToolUseHook({ hooks: "y" }, HOOK_MATCH_KEY);
  assert.deepEqual(out.hooks, {});
});

test("removePreToolUseHook: hooks.PreToolUse is a string => coerced to []", () => {
  const out = removePreToolUseHook({ hooks: { PreToolUse: "z" } }, HOOK_MATCH_KEY);
  assert.deepEqual(out.hooks.PreToolUse, []);
});

// --- upsertMarkedSection / removeMarkedSection -----------------------------

test("upsertMarkedSection: absent => appends a marked block", () => {
  const out = upsertMarkedSection("# Existing prose\n", GTIR_START, GTIR_END, "BODY");
  assert.match(out, /# Existing prose/);
  assert.match(out, new RegExp(`${GTIR_START}[\\s\\S]*BODY[\\s\\S]*${GTIR_END}`));
});

test("upsertMarkedSection: present => replaces just the block, prose intact", () => {
  const first = upsertMarkedSection("# Doc\n\nbefore\n", GTIR_START, GTIR_END, "OLD");
  const second = upsertMarkedSection(first, GTIR_START, GTIR_END, "NEW");
  assert.match(second, /# Doc/);
  assert.match(second, /before/);
  assert.match(second, /NEW/);
  assert.ok(!second.includes("OLD"), "old body replaced");
  // exactly one marked block
  assert.equal(second.split(GTIR_START).length - 1, 1);
  assert.equal(second.split(GTIR_END).length - 1, 1);
});

test("upsertMarkedSection: idempotent — same body twice is byte-identical", () => {
  const once = upsertMarkedSection("# Doc\n", GTIR_START, GTIR_END, "BODY");
  const twice = upsertMarkedSection(once, GTIR_START, GTIR_END, "BODY");
  assert.equal(twice, once);
});

test("removeMarkedSection: present => block gone, surrounding prose preserved", () => {
  const withBlock = upsertMarkedSection("# Doc\n\nkeep me\n", GTIR_START, GTIR_END, "BODY");
  const out = removeMarkedSection(withBlock, GTIR_START, GTIR_END);
  assert.ok(!out.includes(GTIR_START));
  assert.ok(!out.includes(GTIR_END));
  assert.ok(!out.includes("BODY"));
  assert.match(out, /# Doc/);
  assert.match(out, /keep me/);
});

test("removeMarkedSection: absent => no-op (returns text unchanged modulo trailing ws)", () => {
  const text = "# Doc\n\nno gtir here\n";
  assert.equal(removeMarkedSection(text, GTIR_START, GTIR_END), text);
});

test("upsert then remove round-trips to the original prose (modulo trailing whitespace)", () => {
  const original = "# Doc\n\nsome prose here\n";
  const added = upsertMarkedSection(original, GTIR_START, GTIR_END, gtirNavBody());
  const removed = removeMarkedSection(added, GTIR_START, GTIR_END);
  assert.equal(removed.replace(/\s+$/, ""), original.replace(/\s+$/, ""));
});

// --- hooknudge (testable pure handler) --------------------------------------

test("hooknudge: Grep PreToolUse JSON => additionalContext nudge", () => {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "foo" } });
  const out = hooknudge(input);
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /mcp__gtir__search_code/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /mcp__gtir__find_code/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /mcp__gtir__context/);
});

test("hooknudge: Glob => nudge too", () => {
  const out = hooknudge(JSON.stringify({ tool_name: "Glob", tool_input: {} }));
  assert.ok(out.length > 0);
  assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName, "PreToolUse");
});

test("hooknudge: a non-Grep/Glob tool (Read) => empty string", () => {
  assert.equal(hooknudge(JSON.stringify({ tool_name: "Read", tool_input: {} })), "");
});

test("hooknudge: malformed / empty stdin => empty string, never throws", () => {
  assert.equal(hooknudge(""), "");
  assert.equal(hooknudge("not json {{{"), "");
  assert.equal(hooknudge(undefined), "");
  assert.equal(hooknudge(JSON.stringify({ no_tool: true })), "");
});

// --- hooknudge wired through the real CLI (stdin → stdout) ------------------

test("CLI `gtir hooknudge`: Grep stdin => nudge JSON on stdout, exit 0", () => {
  const out = execFileSync("node", [BIN, "hooknudge"], {
    input: JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "x" } }),
    encoding: "utf8",
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /mcp__gtir__/);
});

test("CLI `gtir hooknudge`: Read stdin => no stdout, exit 0", () => {
  const out = execFileSync("node", [BIN, "hooknudge"], {
    input: JSON.stringify({ tool_name: "Read", tool_input: {} }),
    encoding: "utf8",
  });
  assert.equal(out, "");
});

test("CLI `gtir hooknudge`: malformed stdin => no stdout, exit 0 (never throws)", () => {
  const out = execFileSync("node", [BIN, "hooknudge"], { input: "not json {{{", encoding: "utf8" });
  assert.equal(out, "");
});

// --- CLI integration in a temp repo -----------------------------------------

function seedRepo() {
  const repo = tmp();
  // Pre-seed an UNRELATED mcp server + unrelated CLAUDE.md prose + an unrelated hook.
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: ["y"] } } }, null, 2) + "\n");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] }] } }, null, 2) + "\n");
  writeFileSync(join(repo, "CLAUDE.md"), "# Project\n\nUnrelated existing guidance.\n");
  return repo;
}

test("runInstall: writes 3 files, merges into pre-existing content, all valid JSON", () => {
  const repo = seedRepo();
  runInstall({ repo });

  const mcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers.gtir, "gtir server added");
  assert.deepEqual(mcp.mcpServers.other, { command: "x", args: ["y"] }, "unrelated server preserved");
  assert.equal(mcp.mcpServers.gtir.command, "node");
  assert.equal(mcp.mcpServers.gtir.args[0], BIN);

  const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.hooks.PreToolUse.some((e) => e.matcher === "Bash"), "unrelated hook preserved");
  const gtirHook = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => /hooknudge/.test(h.command)));
  assert.ok(gtirHook, "gtir hook added");
  assert.equal(gtirHook.matcher, "Grep|Glob");
  assert.ok(!gtirHook.hooks[0].command.includes("\\"), "no backslashes in hook command");

  const md = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  assert.match(md, /Unrelated existing guidance/, "prose preserved");
  assert.match(md, new RegExp(GTIR_START));
  assert.match(md, /mcp__gtir__search_code/);
});

test("runInstall twice => byte-identical files (idempotent)", () => {
  const repo = seedRepo();
  runInstall({ repo });
  const a = {
    mcp: readFileSync(join(repo, ".mcp.json"), "utf8"),
    settings: readFileSync(join(repo, ".claude", "settings.json"), "utf8"),
    md: readFileSync(join(repo, "CLAUDE.md"), "utf8"),
  };
  runInstall({ repo });
  const b = {
    mcp: readFileSync(join(repo, ".mcp.json"), "utf8"),
    settings: readFileSync(join(repo, ".claude", "settings.json"), "utf8"),
    md: readFileSync(join(repo, "CLAUDE.md"), "utf8"),
  };
  assert.equal(b.mcp, a.mcp);
  assert.equal(b.settings, a.settings);
  assert.equal(b.md, a.md);
});

test("runInstall then --uninstall => gtir bits gone, unrelated content restored", () => {
  const repo = seedRepo();
  const original = {
    mcp: readFileSync(join(repo, ".mcp.json"), "utf8"),
    settings: readFileSync(join(repo, ".claude", "settings.json"), "utf8"),
    md: readFileSync(join(repo, "CLAUDE.md"), "utf8"),
  };
  runInstall({ repo });
  runInstall({ repo, uninstall: true });

  const mcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
  assert.ok(!mcp.mcpServers.gtir, "gtir server removed");
  assert.deepEqual(mcp.mcpServers.other, { command: "x", args: ["y"] }, "unrelated server intact");

  const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
  assert.ok(!settings.hooks.PreToolUse.some((e) => e.hooks.some((h) => /hooknudge/.test(h.command))), "gtir hook removed");
  assert.ok(settings.hooks.PreToolUse.some((e) => e.matcher === "Bash"), "unrelated hook intact");

  const md = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  assert.ok(!md.includes(GTIR_START), "gtir section removed");
  assert.match(md, /Unrelated existing guidance/, "prose intact");

  // Files still exist (never deleted on uninstall).
  assert.ok(existsSync(join(repo, ".mcp.json")));
  assert.ok(existsSync(join(repo, ".claude", "settings.json")));
  assert.ok(existsSync(join(repo, "CLAUDE.md")));
});

test("runInstall on a bare repo creates the 3 files (.claude/ dir created)", () => {
  const repo = tmp();
  runInstall({ repo });
  assert.ok(existsSync(join(repo, ".mcp.json")));
  assert.ok(existsSync(join(repo, ".claude", "settings.json")));
  assert.ok(existsSync(join(repo, "CLAUDE.md")));
  // valid JSON
  JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
  JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
});

test("runInstall --uninstall on a bare repo (no pre-existing config) creates NO files", () => {
  const repo = tmp();
  runInstall({ repo, uninstall: true });
  // Nothing of ours existed to remove, so uninstall must not litter the repo.
  assert.ok(!existsSync(join(repo, ".mcp.json")), ".mcp.json must not be created on bare uninstall");
  assert.ok(!existsSync(join(repo, ".claude", "settings.json")), "settings.json must not be created on bare uninstall");
  assert.ok(!existsSync(join(repo, ".claude")), ".claude/ dir must not be created on bare uninstall");
  assert.ok(!existsSync(join(repo, "CLAUDE.md")), "CLAUDE.md must not be created on bare uninstall");
});

test("runInstall --uninstall only writes the target files that already existed", () => {
  const repo = tmp();
  // Only CLAUDE.md pre-exists (with unrelated prose, no gtir block).
  writeFileSync(join(repo, "CLAUDE.md"), "# Project\n\nUnrelated existing guidance.\n");
  runInstall({ repo, uninstall: true });
  // The pre-existing file is written (cleaned), the absent ones are left absent.
  assert.ok(existsSync(join(repo, "CLAUDE.md")), "pre-existing CLAUDE.md is still present");
  assert.match(readFileSync(join(repo, "CLAUDE.md"), "utf8"), /Unrelated existing guidance/);
  assert.ok(!existsSync(join(repo, ".mcp.json")), "absent .mcp.json not created");
  assert.ok(!existsSync(join(repo, ".claude")), "absent .claude/ not created");
});

test("runInstall: written hook command path exists on disk and parses inside JSON", () => {
  const repo = tmp();
  runInstall({ repo });
  const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  // Extract the quoted path: node "<path>" hooknudge
  const m = cmd.match(/^node "([^"]+)" hooknudge$/);
  assert.ok(m, "command shape is: node \"<abs>\" hooknudge");
  assert.ok(existsSync(m[1]), "the resolved bin path exists");
});

// --- addMcpServer no-clobber (force flag) ------------------------------------

const RICHER_GTIR = { command: "node", args: [BIN, "mcp", "--repo", "A", "--repo", "B"] };

test("addMcpServer force:false — existing gtir entry preserved unchanged (returns input)", () => {
  const input = { mcpServers: { gtir: RICHER_GTIR } };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = addMcpServer(input, "gtir", gtirMcpEntry(BIN), { force: false });
  // Must be byte-identical: both repos intact
  assert.deepEqual(out, snapshot);
  assert.deepEqual(out.mcpServers.gtir.args, [BIN, "mcp", "--repo", "A", "--repo", "B"]);
});

test("addMcpServer force:true — existing gtir entry overwritten with new default entry", () => {
  const input = { mcpServers: { gtir: RICHER_GTIR } };
  const defaultEntry = gtirMcpEntry(BIN);
  const out = addMcpServer(input, "gtir", defaultEntry, { force: true });
  assert.deepEqual(out.mcpServers.gtir, defaultEntry);
});

test("addMcpServer force:false — absent gtir key gets written (force not needed for new entry)", () => {
  const input = { mcpServers: { playwright: { command: "npx", args: ["playwright"] } } };
  const defaultEntry = gtirMcpEntry(BIN);
  const out = addMcpServer(input, "gtir", defaultEntry, { force: false });
  assert.deepEqual(out.mcpServers.gtir, defaultEntry);
  // Unrelated server still present
  assert.deepEqual(out.mcpServers.playwright, { command: "npx", args: ["playwright"] });
});

test("addMcpServer force:false — a DIFFERENT server name is always preserved", () => {
  const input = { mcpServers: { gtir: RICHER_GTIR, playwright: { command: "npx", args: ["playwright"] } } };
  const out = addMcpServer(input, "gtir", gtirMcpEntry(BIN), { force: false });
  // gtir untouched (no force), playwright still there
  assert.deepEqual(out.mcpServers.gtir, RICHER_GTIR);
  assert.deepEqual(out.mcpServers.playwright, { command: "npx", args: ["playwright"] });
});

test("addMcpServer no opts (backward compat) — behaves like force:false: absent key written, existing preserved", () => {
  // Absent key: still written (same as old behavior)
  const fresh = addMcpServer({}, "gtir", gtirMcpEntry(BIN));
  assert.deepEqual(fresh.mcpServers.gtir, gtirMcpEntry(BIN));
  // Existing key: now PRESERVED (changed behavior — no-clobber by default)
  const existing = addMcpServer({ mcpServers: { gtir: RICHER_GTIR } }, "gtir", gtirMcpEntry(BIN));
  assert.deepEqual(existing.mcpServers.gtir, RICHER_GTIR);
});

// --- runInstall no-clobber integration (mkdtemp repo) ------------------------

function seedRepoWithRicherGtir() {
  const repo = tmp();
  // Pre-seed .mcp.json with a richer gtir entry (2 repos)
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({
    mcpServers: { gtir: RICHER_GTIR, other: { command: "x", args: ["y"] } },
  }, null, 2) + "\n");
  // No .claude/ or CLAUDE.md yet — install should create those regardless
  return repo;
}

test("runInstall no-force: richer gtir in .mcp.json is preserved; hook+CLAUDE.md still written", () => {
  const repo = seedRepoWithRicherGtir();
  const mcpBefore = readFileSync(join(repo, ".mcp.json"), "utf8");

  const msgs = [];
  runInstall({ repo, log: (m) => msgs.push(m) });

  // .mcp.json must be byte-identical (richer entry preserved)
  const mcpAfter = readFileSync(join(repo, ".mcp.json"), "utf8");
  assert.equal(mcpAfter, mcpBefore, ".mcp.json must be byte-identical (richer gtir preserved)");

  // The richer entry's repos are still intact
  const mcp = JSON.parse(mcpAfter);
  assert.deepEqual(mcp.mcpServers.gtir.args, [BIN, "mcp", "--repo", "A", "--repo", "B"]);

  // hook was written
  assert.ok(existsSync(join(repo, ".claude", "settings.json")), "settings.json created");
  const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.hooks.PreToolUse.some((e) => e.hooks.some((h) => /hooknudge/.test(h.command))), "gtir hook written");

  // CLAUDE.md was written
  assert.ok(existsSync(join(repo, "CLAUDE.md")), "CLAUDE.md created");
  const md = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  assert.match(md, new RegExp(GTIR_START));
  assert.match(md, /mcp__gtir__search_code/);

  // Log mentions the skip
  assert.ok(msgs.some((m) => /left existing gtir/i.test(m) || /existing/i.test(m)), "log mentions preserved/skipped .mcp.json");
});

test("runInstall --force: richer gtir in .mcp.json is replaced with default entry", () => {
  const repo = seedRepoWithRicherGtir();
  const msgs = [];
  runInstall({ repo, force: true, log: (m) => msgs.push(m) });

  const mcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
  // Default entry: single --repo . --watch
  assert.deepEqual(mcp.mcpServers.gtir, gtirMcpEntry(BIN));
  // Other server preserved
  assert.deepEqual(mcp.mcpServers.other, { command: "x", args: ["y"] });
});

test("runInstall on fresh repo (no .mcp.json) writes the default gtir entry as before", () => {
  const repo = tmp();
  runInstall({ repo });
  const mcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.gtir, gtirMcpEntry(BIN));
});

test("runInstall idempotency with richer gtir: install twice => no change to .mcp.json", () => {
  const repo = seedRepoWithRicherGtir();
  runInstall({ repo });
  const after1 = readFileSync(join(repo, ".mcp.json"), "utf8");
  runInstall({ repo });
  const after2 = readFileSync(join(repo, ".mcp.json"), "utf8");
  assert.equal(after2, after1, ".mcp.json unchanged on second install");
});

// --- verify predicates ---------------------------------------------------------

test("mcpHasGtir: true only when mcpServers.gtir is present", () => {
  assert.equal(mcpHasGtir({ mcpServers: { gtir: gtirMcpEntry(BIN) } }), true);
  assert.equal(mcpHasGtir({ mcpServers: { other: {} } }), false);
  assert.equal(mcpHasGtir({}), false);
  assert.equal(mcpHasGtir({ mcpServers: "x" }), false); // malformed
  assert.equal(mcpHasGtir(null), false);
});

test("settingsHasHook: true only when a PreToolUse hook command contains the match key", () => {
  const withHook = addPreToolUseHook({}, gtirHookEntry(BIN), HOOK_MATCH_KEY);
  assert.equal(settingsHasHook(withHook), true);
  assert.equal(settingsHasHook({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo" }] }] } }), false);
  assert.equal(settingsHasHook({}), false);
  assert.equal(settingsHasHook({ hooks: "x" }), false); // malformed
});

test("markedSectionPresent: true only when both gtir marks present", () => {
  const withSection = upsertMarkedSection("# Doc\n", GTIR_START, GTIR_END, "BODY");
  assert.equal(markedSectionPresent(withSection), true);
  assert.equal(markedSectionPresent("# Doc\nno marks\n"), false);
  assert.equal(markedSectionPresent(""), false);
  assert.equal(markedSectionPresent(undefined), false);
});

// --- multi-assistant wiring -------------------------------------------------

test("runInstall: always writes AGENTS.md nav section (universal)", () => {
  const repo = tmp();
  runInstall({ repo });
  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  assert.match(agents, new RegExp(GTIR_START));
  assert.match(agents, /mcp__gtir__context/);
});

test("runInstall: no .cursor/ present => Cursor files NOT written (Claude baseline only)", () => {
  const repo = tmp();
  runInstall({ repo });
  assert.ok(!existsSync(join(repo, ".cursor", "mcp.json")), "cursor mcp not written when undetected");
  assert.ok(!existsSync(join(repo, ".cursor", "rules", "gtir.mdc")), "cursor rule not written when undetected");
  assert.ok(existsSync(join(repo, ".mcp.json")));
});

test("runInstall assistants:{cursor} => writes .cursor/mcp.json + owned rule file, skips Claude", () => {
  const repo = tmp();
  runInstall({ repo, assistants: { claude: false, cursor: true } });
  const cmcp = JSON.parse(readFileSync(join(repo, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cmcp.mcpServers.gtir, "gtir registered in .cursor/mcp.json");
  const rule = readFileSync(join(repo, ".cursor", "rules", "gtir.mdc"), "utf8");
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /mcp__gtir__context/);
  assert.ok(!existsSync(join(repo, ".mcp.json")), "Claude .mcp.json not written when claude:false");
  assert.ok(existsSync(join(repo, "AGENTS.md")));
});

test("runInstall then uninstall (cursor): owned rule file deleted, shared cursor mcp keeps other servers", () => {
  const repo = tmp();
  mkdirSync(join(repo, ".cursor"), { recursive: true });
  writeFileSync(join(repo, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }, null, 2) + "\n");
  const sel = { claude: false, cursor: true };
  runInstall({ repo, assistants: sel });
  assert.ok(existsSync(join(repo, ".cursor", "rules", "gtir.mdc")), "rule written");

  runInstall({ repo, uninstall: true, assistants: sel });
  assert.ok(!existsSync(join(repo, ".cursor", "rules", "gtir.mdc")), "owned rule deleted on uninstall");
  const cmcp = JSON.parse(readFileSync(join(repo, ".cursor", "mcp.json"), "utf8"));
  assert.ok(!cmcp.mcpServers.gtir, "gtir removed from cursor mcp");
  assert.deepEqual(cmcp.mcpServers.other, { command: "x", args: [] }, "unrelated cursor server intact");
});

test("runInstall --uninstall on a bare repo creates NO files (AGENTS.md included)", () => {
  const repo = tmp();
  runInstall({ repo, uninstall: true });
  assert.ok(!existsSync(join(repo, "AGENTS.md")), "AGENTS.md not created on bare uninstall");
  assert.ok(!existsSync(join(repo, ".cursor")), ".cursor/ not created on bare uninstall");
});

// --- CLI orchestration (no Ollama: use --no-index, and --verify) -------------

test("CLI `gtir install --no-index`: wires Claude + AGENTS.md without building an index", () => {
  const repo = tmp();
  execFileSync("node", [BIN, "install", "--repo", repo, "--no-index"], { encoding: "utf8" });
  assert.ok(existsSync(join(repo, ".mcp.json")), ".mcp.json written");
  assert.ok(existsSync(join(repo, "AGENTS.md")), "AGENTS.md written");
  assert.ok(!existsSync(join(repo, ".gtir", "index.lance")), "no index built under --no-index");
});

test("CLI `gtir install --no-index --all`: also writes Cursor files", () => {
  const repo = tmp();
  execFileSync("node", [BIN, "install", "--repo", repo, "--no-index", "--all"], { encoding: "utf8" });
  assert.ok(existsSync(join(repo, ".cursor", "mcp.json")), "cursor mcp written under --all");
  assert.ok(existsSync(join(repo, ".cursor", "rules", "gtir.mdc")), "cursor rule written under --all");
});

test("CLI `gtir install --verify`: exit 1 when not wired, exit 0 after wiring", () => {
  const repo = tmp();
  let failed = false;
  try { execFileSync("node", [BIN, "install", "--repo", repo, "--verify"], { encoding: "utf8" }); }
  catch (e) { failed = true; assert.equal(e.status, 1); }
  assert.ok(failed, "verify on an unwired repo exits 1");

  execFileSync("node", [BIN, "install", "--repo", repo, "--no-index"], { encoding: "utf8" });
  mkdirSync(join(repo, ".gtir", "index.lance"), { recursive: true });
  const out = execFileSync("node", [BIN, "install", "--repo", repo, "--verify"], { encoding: "utf8" });
  assert.ok(typeof out === "string");
});

test("CLI `gtir install --assistant=` (empty) falls through to default (Claude wired)", () => {
  const repo = tmp();
  execFileSync("node", [BIN, "install", "--repo", repo, "--no-index", "--assistant="], { encoding: "utf8" });
  // Empty set must NOT silently skip Claude — default keeps Claude on.
  assert.ok(existsSync(join(repo, ".mcp.json")), "Claude .mcp.json written (empty --assistant= ignored)");
  assert.ok(existsSync(join(repo, "AGENTS.md")), "AGENTS.md written");
});

test("CLI `gtir install --verify --all`: exercises cursor verify items, exit 0 when fully wired", () => {
  const repo = tmp();
  execFileSync("node", [BIN, "install", "--repo", repo, "--no-index", "--all"], { encoding: "utf8" });
  mkdirSync(join(repo, ".gtir", "index.lance"), { recursive: true });
  // --all makes verify check the cursor items too; all present => exit 0.
  const out = execFileSync("node", [BIN, "install", "--repo", repo, "--verify", "--all"], { encoding: "utf8" });
  // execFileSync throws on non-zero exit; reaching here = exit 0
  assert.ok(typeof out === "string");
});
