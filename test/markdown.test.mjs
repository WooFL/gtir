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

import { buildSections, sectionPrefix } from "../src/markdown.mjs";

test("buildSections: breadcrumb stack pops on same-or-shallower level", () => {
  const lines = ["# A", "a", "## B", "b", "### C", "c", "## D", "d"];
  const secs = buildSections(lines, scanHeadings(lines, 0), 0, "Root");
  assert.deepEqual(secs.map((s) => s.breadcrumb.join("/")),
    ["Root/A", "Root/A/B", "Root/A/B/C", "Root/A/D"]);
});

test("buildSections: preamble emitted; heading-only section flagged", () => {
  const lines = ["pre", "# A", "## B", "b"]; // "# A" has only "## B" after it => heading-only
  const secs = buildSections(lines, scanHeadings(lines, 0), 0, "R");
  assert.equal(secs[0].breadcrumb.join("/"), "R");           // preamble ("pre")
  assert.equal(secs.find((s) => s.breadcrumb.join("/") === "R/A").headingOnly, true);
  assert.equal(secs.find((s) => s.breadcrumb.join("/") === "R/A/B").headingOnly, false);
});

test("sectionPrefix formats path › breadcrumb [tags]", () => {
  assert.equal(sectionPrefix("c/x.md", ["X", "Sec"], ["t1", "t2"]), "c/x.md › X › Sec  [tags: t1, t2]");
  assert.equal(sectionPrefix("c/x.md", ["X"], []), "c/x.md › X");
});

import { chunkMarkdown } from "../src/markdown.mjs";

const cfg = { maxChars: 2000, minChars: 80, overlapChars: 100 };

test("chunkMarkdown: content section -> chunk w/ breadcrumb+tags prefix; heading-only skipped", () => {
  const text = [
    "---", "title: Auth Guide", "tags: [auth]", "---",
    "# Auth Guide",
    "",
    "## Tokens",
    "How tokens refresh and rotate over time in this system, with enough characters here.",
    "## Empty",
  ].join("\n");
  const chunks = chunkMarkdown("notes/auth.md", text, cfg);
  // "# Auth Guide" (only a blank line before "## Tokens") and "## Empty" (EOF) are heading-only -> skipped.
  assert.equal(chunks.length, 1);
  const c = chunks[0];
  assert.equal(c.language, "markdown");
  assert.match(c.text, /How tokens refresh/);
  assert.match(c.prefix, /notes\/auth\.md › Auth Guide › Tokens/);
  assert.match(c.prefix, /\[tags: auth\]/);
});

test("chunkMarkdown: no headings -> single preamble chunk, root = filename stem", () => {
  const text = "Just a paragraph of prose with plenty of characters to be a real chunk here, yes indeed.";
  const chunks = chunkMarkdown("notes/loose.md", text, cfg);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].prefix, /notes\/loose\.md › loose/);
});

test("chunkMarkdown: oversize section is split; all sub-chunks share one prefix", () => {
  const big = Array.from({ length: 80 }, (_, i) => `line ${i} of a long section body that keeps going on`).join("\n");
  const chunks = chunkMarkdown("n.md", `## Big\n${big}`, { maxChars: 400, minChars: 40, overlapChars: 0 });
  assert.ok(chunks.length >= 2);
  const prefixes = new Set(chunks.map((c) => c.prefix));
  assert.equal(prefixes.size, 1);
  assert.match([...prefixes][0], /n\.md › n › Big/);
});

test("chunkMarkdown: char/line offsets map into the original text", () => {
  const text = "# A\nalpha body line that is clearly long enough to be a chunk on its own here.\n## B\nbeta body line also long enough to be a standalone chunk for testing offsets.";
  const chunks = chunkMarkdown("n.md", text, cfg);
  const b = chunks.find((c) => /beta body/.test(c.text));
  assert.equal(text.slice(b.chunkStart, b.chunkStart + 4), "## B"); // chunkStart points at the "## B" heading
  assert.equal(b.lineStart, 3); // "## B" is line 3 (1-indexed)
});

test("chunkMarkdown: CRLF frontmatter is parsed (title/tags not dropped)", () => {
  const text = "---\r\ntitle: CRLF Page\r\ntags: [x, y]\r\n---\r\n## Sec\r\nbody content that is plenty long enough to be a real chunk here for the test.\r\n";
  const chunks = chunkMarkdown("n.md", text, cfg);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].prefix, /n\.md › CRLF Page › Sec/);
  assert.match(chunks[0].prefix, /\[tags: x, y\]/);
  assert.ok(!chunks[0].text.includes("title:"), "raw YAML must not leak into the chunk body");
});

test("chunkMarkdown: oversize sub-chunk offsets map back into the original text", () => {
  const big = Array.from({ length: 80 }, (_, i) => `line ${i} of a long section body that keeps going on`).join("\n");
  const text = `## Big\n${big}`;
  const chunks = chunkMarkdown("n.md", text, { maxChars: 400, minChars: 40, overlapChars: 0 });
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.equal(text.slice(c.chunkStart, c.chunkEnd), c.text, "sub-chunk char offsets must slice to its text");
  }
});

test("scanHeadings: a whitespace-only heading line is not a heading", () => {
  const lines = ["#    ", "# Real Title", "##\t  "];
  assert.deepEqual(scanHeadings(lines, 0).map((h) => h.title), ["Real Title"]);
});
