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
