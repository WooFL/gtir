import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchToolCall, findWikiAndCode, filterReportToNote } from "../src/mcp.mjs";

function ctx(overrides = {}) {
  return {
    indexes: [
      { label: "notes", repo: "/wiki", cfg: { indexDir: "/wiki/.gtir", model: "nomic-embed-text" } },
      { label: "code", repo: "/code", cfg: { indexDir: "/code/.gtir", model: "qwen3" } },
    ],
    staleCheckFn: async () => ({ stale: [{ note: "a.md", rows: [{ symbol: "f", codePath: "a.ts", lines: "1-3", severity: "body", priority: "medium", before: {}, after: {} }] }], staleNotes: 1, staleLinks: 1 }),
    staleAckFn: async (note) => ({ acked: note, links: 1 }),
    ...overrides,
  };
}

test("stale_check returns the drift report", async () => {
  const res = await dispatchToolCall({ name: "stale_check", arguments: {} }, ctx());
  assert.equal(res.structuredContent.staleNotes, 1);
  assert.equal(res.structuredContent.stale[0].note, "a.md");
});

test("stale_ack acks a note", async () => {
  const res = await dispatchToolCall({ name: "stale_ack", arguments: { note: "a.md" } }, ctx());
  assert.equal(res.structuredContent.acked, "a.md");
});

test("stale_check surfaces an error (not a throw) when code index missing", async () => {
  const c = ctx();
  c.indexes = [c.indexes[0]]; // notes only
  c.staleCheckFn = async () => ({ error: "stale needs a code index — configure both a notes and a code repo" });
  const res = await dispatchToolCall({ name: "stale_check", arguments: {} }, c);
  assert.match(res.content[0].text, /code index/);
  assert.equal(res.isError, true);
});

test("findWikiAndCode picks the notes index and the code index", () => {
  const { wiki, code } = findWikiAndCode([
    { label: "code", cfg: { model: "qwen3" } },
    { label: "notes", cfg: { model: "nomic-embed-text" } },
  ]);
  assert.equal(wiki.label, "notes");
  assert.equal(code.label, "code");
});

test("findWikiAndCode returns undefined code when only a notes index is served", () => {
  const { wiki, code } = findWikiAndCode([{ label: "notes", cfg: { model: "nomic-embed-text" } }]);
  assert.equal(wiki.label, "notes");
  assert.equal(code, undefined);
});

test("filterReportToNote narrows to one note and recomputes counts", () => {
  const report = { stale: [
    { note: "a.md", rows: [{ symbol: "f" }] },
    { note: "b.md", rows: [{ symbol: "g" }, { symbol: "h" }] },
  ], staleNotes: 2, staleLinks: 3 };
  const out = filterReportToNote(report, "b.md");
  assert.equal(out.staleNotes, 1);
  assert.equal(out.staleLinks, 2);
  assert.equal(out.stale[0].note, "b.md");
});

test("filterReportToNote is a pass-through when note is absent or report errored", () => {
  const report = { stale: [{ note: "a.md", rows: [] }], staleNotes: 1, staleLinks: 0 };
  assert.equal(filterReportToNote(report, undefined), report);
  const err = { error: "x" };
  assert.equal(filterReportToNote(err, "a.md"), err);
});
