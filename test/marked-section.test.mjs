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
