import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchToolCall } from "../src/mcp.mjs";

test("dispatchToolCall stale_sync: delegates to ctx.staleSyncFn and returns its report", async () => {
  const fake = { synced: [{ note: "m.md", refsRefreshed: true, acked: ["a"], flagged: [] }], needsProse: [], writeErrors: [] };
  const ctx = { indexes: [], staleSyncFn: async (args) => { assert.equal(args.init, true); return fake; } };
  const out = await dispatchToolCall({ name: "stale_sync", arguments: { init: true } }, ctx);
  assert.deepEqual(out.structuredContent, fake);
  assert.match(out.content[0].text, /m\.md/);
});

test("dispatchToolCall stale_sync: surfaces an error object as isError", async () => {
  const ctx = { indexes: [], staleSyncFn: async () => ({ error: "no baseline — run: gtir stale baseline" }) };
  const out = await dispatchToolCall({ name: "stale_sync", arguments: {} }, ctx);
  assert.ok(out.isError);
  assert.match(out.content[0].text, /no baseline/);
});
