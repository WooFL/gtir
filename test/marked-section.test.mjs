import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertMarkedSection, removeMarkedSection } from "../src/marked-section.mjs";

const S = "<!-- x:start -->", E = "<!-- x:end -->";

test("upsertMarkedSection: absent => appends a marked block", () => {
  const out = upsertMarkedSection("# Doc\n", S, E, "BODY");
  assert.match(out, /# Doc/);
  assert.match(out, new RegExp(`${S}[\\s\\S]*BODY[\\s\\S]*${E}`));
});

test("upsertMarkedSection: present => replaces just the block; idempotent", () => {
  const once = upsertMarkedSection("# Doc\n\nkeep\n", S, E, "A");
  const twice = upsertMarkedSection(once, S, E, "A");
  assert.equal(twice, once);
  const changed = upsertMarkedSection(once, S, E, "B");
  assert.match(changed, /keep/);
  assert.match(changed, /B/);
  assert.ok(!changed.includes("A"));
});

test("removeMarkedSection: removes block, preserves prose; round-trips", () => {
  const original = "# Doc\n\nprose\n";
  const added = upsertMarkedSection(original, S, E, "BODY");
  const removed = removeMarkedSection(added, S, E);
  assert.equal(removed.replace(/\s+$/, ""), original.replace(/\s+$/, ""));
});

const noBareLf = (s) => !/(?<!\r)\n/.test(s); // every "\n" is part of a "\r\n"

test("upsertMarkedSection: CRLF host => block written CRLF, no mixed EOL, idempotent", () => {
  const src = "# Doc\r\n\r\nkeep\r\n";
  const out = upsertMarkedSection(src, S, E, "row1\nrow2"); // body arrives LF (like renderRefsTable)
  assert.ok(out.includes(S) && out.includes("row1") && out.includes("row2"));
  assert.ok(noBareLf(out), "every newline is CRLF — no bare LF leaked into a CRLF file");
  assert.match(out, /keep/);
  assert.equal(upsertMarkedSection(out, S, E, "row1\nrow2"), out, "idempotent on CRLF");
});

test("removeMarkedSection: CRLF host => strips block, preserves CRLF prose", () => {
  const added = upsertMarkedSection("# Doc\r\n\r\nprose\r\n", S, E, "BODY");
  const removed = removeMarkedSection(added, S, E);
  assert.ok(noBareLf(removed), "no bare LF after removal");
  assert.match(removed, /prose/);
  assert.ok(!removed.includes(S));
});
