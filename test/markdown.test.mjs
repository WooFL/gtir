import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/markdown.mjs";
import { scanHeadings } from "../src/markdown.mjs";

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

test("scanHeadings: ATX levels + line indices; ignores # inside code fences", () => {
  const text = [
    "# Top",           // 0
    "intro",           // 1
    "## A",            // 2
    "```js",           // 3  fence open
    "# not a heading", // 4  inside fence
    "```",             // 5  fence close
    "## B",            // 6
    "~~~",             // 7  tilde fence open
    "### also not",    // 8  inside fence
    "~~~",             // 9  fence close
    "#### Real",       // 10
  ].join("\n");
  const hs = scanHeadings(text.split("\n"), 0);
  assert.deepEqual(hs.map((h) => `${h.level}:${h.title}@${h.lineIdx}`),
    ["1:Top@0", "2:A@2", "2:B@6", "4:Real@10"]);
});

test("scanHeadings: respects bodyStartLineIdx (skips frontmatter region)", () => {
  const lines = ["---", "title: x", "---", "# Body H1"];
  assert.deepEqual(scanHeadings(lines, 3).map((h) => h.title), ["Body H1"]);
});
