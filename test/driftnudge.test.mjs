import { test } from "node:test";
import assert from "node:assert/strict";
import { driftnudge, formatDriftNudge } from "../src/driftnudge.mjs";

const fakeRev = (byPath) => ({ bySymbol: new Map(), byPath: new Map(Object.entries(byPath)) });
const payload = (tool, file) => JSON.stringify({ tool_name: tool, tool_input: { file_path: file } });
const docDeps = {
  loadConfig: () => ({ repo: "/code", wiki: "../wiki" }),
  reverseLinks: async () => fakeRev({ "src/a.ts": [{ note: "modules/a.md" }] }),
};

test("formatDriftNudge lists the edited file + note names", () => {
  const t = formatDriftNudge("src/a.ts", [{ note: "modules/a.md" }, { note: "x.md" }]);
  assert.match(t, /src\/a\.ts/);
  assert.match(t, /modules\/a\.md/);
  assert.match(t, /x\.md/);
});

test("formatDriftNudge caps the list and appends a (+N more) count", () => {
  const notes = Array.from({ length: 25 }, (_, i) => ({ note: `n${i}.md` }));
  const t = formatDriftNudge("src/a.ts", notes, 8);
  assert.match(t, /n0\.md/);
  assert.match(t, /n7\.md/);
  assert.ok(!t.includes("n8.md"), "9th note not listed");
  assert.match(t, /\(\+17 more\)/);
});

test("driftnudge: caps the nudge to cfg.relatedNotesCap (central files don't dump dozens)", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ note: `concepts/c${i}.md` }));
  const deps = {
    loadConfig: () => ({ repo: "/code", wiki: "../wiki", relatedNotesCap: 5 }),
    reverseLinks: async () => fakeRev({ "src/a.ts": many }),
  };
  const ctx = JSON.parse(await driftnudge(payload("Edit", "/code/src/a.ts"), { cwd: "/code", deps })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /concepts\/c0\.md/);
  assert.ok(!ctx.includes("concepts/c5.md"), "6th note not listed (cap 5)");
  assert.match(ctx, /\(\+25 more\)/);
});

test("driftnudge: honors the wiki's staleIgnore — archived notes dropped from the nudge", async () => {
  const deps = {
    loadConfig: () => ({ repo: "/code", wiki: "../wiki", staleIgnore: [".raw/"] }),
    reverseLinks: async () => fakeRev({ "src/a.ts": [{ note: "modules/a.md" }, { note: ".raw/x.md" }] }),
  };
  const ctx = JSON.parse(await driftnudge(payload("Edit", "/code/src/a.ts"), { cwd: "/code", deps })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /modules\/a\.md/);
  assert.ok(!ctx.includes(".raw/x.md"), "archived .raw note excluded from the nudge");
});

test("driftnudge: silent when every documenting note is staleIgnore'd", async () => {
  const deps = {
    loadConfig: () => ({ repo: "/code", wiki: "../wiki", staleIgnore: [".raw/"] }),
    reverseLinks: async () => fakeRev({ "src/a.ts": [{ note: ".raw/only.md" }] }),
  };
  assert.equal(await driftnudge(payload("Edit", "/code/src/a.ts"), { cwd: "/code", deps }), "");
});

test("driftnudge: edit of a documented file => PostToolUse additionalContext naming the notes", async () => {
  const out = await driftnudge(payload("Edit", "/code/src/a.ts"), { cwd: "/code", deps: docDeps });
  const j = JSON.parse(out);
  assert.equal(j.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(j.hookSpecificOutput.additionalContext, /modules\/a\.md/);
});

test("driftnudge: silent ('') for the no-op cases", async () => {
  assert.equal(await driftnudge(payload("Grep", "/code/src/a.ts"), { cwd: "/code", deps: docDeps }), "");
  assert.equal(await driftnudge(JSON.stringify({ tool_name: "Edit", tool_input: {} }), { cwd: "/code", deps: docDeps }), "");
  assert.equal(await driftnudge(payload("Edit", "/code/src/a.ts"),
    { cwd: "/code", deps: { loadConfig: () => ({ repo: "/code" }), reverseLinks: async () => fakeRev({}) } }), "");
  assert.equal(await driftnudge(payload("Edit", "/elsewhere/x.ts"), { cwd: "/code", deps: docDeps }), "");
  assert.equal(await driftnudge(payload("Edit", "/code/src/other.ts"), { cwd: "/code", deps: docDeps }), "");
  assert.equal(await driftnudge("not json", { cwd: "/code", deps: docDeps }), "");
  assert.match(JSON.parse(await driftnudge(payload("Write", "/code/src/a.ts"), { cwd: "/code", deps: docDeps })).hookSpecificOutput.additionalContext, /modules\/a\.md/);
  assert.match(JSON.parse(await driftnudge(payload("MultiEdit", "/code/src/a.ts"), { cwd: "/code", deps: docDeps })).hookSpecificOutput.additionalContext, /modules\/a\.md/);
});
