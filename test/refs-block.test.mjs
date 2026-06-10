import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REFS_START, REFS_END, STALE_START, STALE_END,
  renderRefsTable, renderStaleCallout,
  upsertRefsBlock, removeRefsBlock, hasRefsBlock,
  upsertStaleCallout, removeStaleCallout,
} from "../src/refs-block.mjs";

const SYM = { kind: "symbol", symbol: "bm25Score", path: "src/search.mjs", lines: "42-71", sig: "bm25Score(q, doc, idf)" };
const FILE = { kind: "file", path: "src/search.mjs" };

test("renderRefsTable: symbol row + footer sha", () => {
  const t = renderRefsTable([SYM], "abc123");
  assert.match(t, /\| symbol \| location \| signature \|/);
  assert.match(t, /`bm25Score`/);
  assert.match(t, /src\/search\.mjs:42-71/);
  assert.match(t, /`bm25Score\(q, doc, idf\)`/);
  assert.match(t, /_synced abc123_/);
});

test("renderRefsTable: file row renders as (file); pipe in sig escaped; empty => placeholder row", () => {
  assert.match(renderRefsTable([FILE], "x"), /`\(file\)`/);
  const piped = renderRefsTable([{ kind: "symbol", symbol: "f", path: "a.ts", lines: "1-2", sig: "f(): A | B" }], "x");
  assert.match(piped, /A \\\| B/); // pipe escaped so the table cell isn't split
  assert.match(renderRefsTable([], "x"), /no resolved code refs/);
});

test("renderStaleCallout: warning callout lists symbols", () => {
  const c = renderStaleCallout(["rankRRF", "foo"]);
  assert.match(c, /\[!warning\]/);
  assert.match(c, /`rankRRF`/);
  assert.match(c, /`foo`/);
});

test("upsert/removeRefsBlock: round-trips, prose preserved, idempotent", () => {
  const original = "# search\n\nBM25 lives in `src/search.mjs`.\n";
  const added = upsertRefsBlock(original, [SYM], "sha1");
  assert.ok(hasRefsBlock(added));
  assert.match(added, /BM25 lives in/);
  assert.match(added, new RegExp(REFS_START));
  const again = upsertRefsBlock(added, [SYM], "sha1");
  assert.equal(again, added); // idempotent
  const removed = removeRefsBlock(added);
  assert.ok(!hasRefsBlock(removed));
  assert.equal(removed.replace(/\s+$/, ""), original.replace(/\s+$/, ""));
});

test("upsert/removeStaleCallout: round-trips", () => {
  const base = "# n\n\nprose\n";
  const withCallout = upsertStaleCallout(base, ["x"]);
  assert.match(withCallout, new RegExp(STALE_START));
  assert.match(withCallout, /\[!warning\]/);
  const cleared = removeStaleCallout(withCallout);
  assert.ok(!cleared.includes(STALE_START));
  assert.match(cleared, /prose/);
});
