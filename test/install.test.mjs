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
  gtirClaudeMdBody,
  addMcpServer,
  removeMcpServer,
  addPreToolUseHook,
  removePreToolUseHook,
  upsertMarkedSection,
  removeMarkedSection,
  hooknudge,
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

test("gtirClaudeMdBody: factual nudge naming both MCP tools", () => {
  const body = gtirClaudeMdBody();
  assert.match(body, /mcp__gtir__search_code/);
  assert.match(body, /mcp__gtir__find_code/);
  assert.match(body, /Grep/);
  assert.match(body, /Glob/);
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
  const added = upsertMarkedSection(original, GTIR_START, GTIR_END, gtirClaudeMdBody());
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
