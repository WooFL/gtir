import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/markdown.mjs";

test("parseFrontmatter: title + inline tags; bodyStartLineIdx after closing ---", () => {
  const text = "---\ntitle: My Page\ntags: [auth, security]\n---\n# H1\nbody\n";
  const fm = parseFrontmatter(text.split("\n"));
  assert.equal(fm.title, "My Page");
  assert.deepEqual(fm.tags, ["auth", "security"]);
  assert.equal(fm.bodyStartLineIdx, 4); // lines 0..3 are frontmatter; body starts at line 4 ("# H1")
});

test("parseFrontmatter: block-list tags and quoted scalar title", () => {
  const text = "---\ntitle: \"Quoted Title\"\ntags:\n  - a\n  - b\n---\nbody";
  const fm = parseFrontmatter(text.split("\n"));
  assert.equal(fm.title, "Quoted Title");
  assert.deepEqual(fm.tags, ["a", "b"]);
});

test("parseFrontmatter: no or unclosed frontmatter => bodyStartLineIdx 0, no title", () => {
  assert.equal(parseFrontmatter("# H1\nbody".split("\n")).bodyStartLineIdx, 0);
  const unclosed = parseFrontmatter("---\ntitle: x\nno closing fence".split("\n"));
  assert.equal(unclosed.bodyStartLineIdx, 0);
  assert.equal(unclosed.title, null);
});
