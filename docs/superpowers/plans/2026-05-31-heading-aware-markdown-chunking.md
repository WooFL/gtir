# Heading-aware Markdown Chunking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chunk `.md`/`.mdx` on heading boundaries (not char windows), with each section carrying its heading breadcrumb + frontmatter tags into the embedding.

**Architecture:** A new `src/markdown.mjs` (hand-written, fence-aware — there is no markdown tree-sitter grammar) builds sections from ATX headings and emits gtir's standard chunk shape plus a precomputed `prefix`. Two small touch-points: `chunkFile` routes markdown to it, and `contextualizeChunk` honors a chunk's `prefix`. Oversize sections reuse `chunkRecursive`. No changes to embedding/store/search.

**Tech Stack:** Node ≥20 ESM, `node:test`. Reuses `src/chunker.mjs` (`chunkRecursive`), `src/contextualize.mjs`.

**Spec:** `docs/superpowers/specs/2026-05-31-heading-aware-markdown-chunking-design.md`.

---

## File Structure

```
src/markdown.mjs        NEW — parseFrontmatter, scanHeadings, buildSections, sectionPrefix, chunkMarkdown
src/chunker.mjs         MODIFY — chunkFile routes langId "markdown" -> chunkMarkdown
src/contextualize.mjs   MODIFY — contextualizeChunk honors chunk.prefix
test/markdown.test.mjs  NEW — unit tests for the markdown module
test/chunker.test.mjs   MODIFY — add the .md routing test
test/contextualize.test.mjs MODIFY — add the prefix-honoring tests
README.md               MODIFY — note markdown is heading-aware
```

**Circular import note (safe):** `markdown.mjs` imports `chunkRecursive` from `chunker.mjs`, and `chunker.mjs` imports `chunkMarkdown` from `markdown.mjs`. This is a runtime-only cycle — both imported functions are *declarations* (hoisted) and are only *called* at runtime (never during module evaluation), so ESM live-bindings resolve cleanly. Do not "fix" it by inlining; it is correct.

**Breadcrumb separator:** the constant `SEP = " › "` (U+203A, space-padded). Used in both the breadcrumb join and the path/breadcrumb/tags assembly.

---

## Task 1: `parseFrontmatter`

**Files:**
- Create: `gtir/src/markdown.mjs`
- Test: `gtir/test/markdown.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gtir/test/markdown.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/markdown.test.mjs`
Expected: FAIL — `Cannot find module '../src/markdown.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `gtir/src/markdown.mjs`:

```js
import { basename } from "node:path";
import { chunkRecursive } from "./chunker.mjs";

export const SEP = " › ";

function stripQuotes(s) { return s.replace(/^["']|["']$/g, "").trim(); }

function parseListValue(val, lines, keyLineIdx, close) {
  let v = val.trim();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  if (v) return v.split(",").map((s) => stripQuotes(s)).filter(Boolean);
  // block list: subsequent "- item" lines until the next key or the closing ---
  const out = [];
  for (let i = keyLineIdx + 1; i < close; i++) {
    const m = lines[i].match(/^\s*-\s+(.*)$/);
    if (!m) break;
    out.push(stripQuotes(m[1]));
  }
  return out.filter(Boolean);
}

export function parseFrontmatter(lines) {
  const none = { title: null, tags: [], aliases: [], bodyStartLineIdx: 0 };
  if (lines[0] !== "---") return none;
  let close = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i] === "---") { close = i; break; } }
  if (close === -1) return none;
  const meta = { title: null, tags: [], aliases: [], bodyStartLineIdx: close + 1 };
  for (let i = 1; i < close; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "title") meta.title = stripQuotes(m[2]) || null;
    else if (key === "tags" || key === "aliases") meta[key] = parseListValue(m[2], lines, i, close);
  }
  return meta;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/markdown.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/markdown.mjs test/markdown.test.mjs && git commit -m "feat(gtir): markdown frontmatter parser (title/tags + body offset)"
```

---

## Task 2: `scanHeadings` (fence-aware)

**Files:**
- Modify: `gtir/src/markdown.mjs`
- Test: `gtir/test/markdown.test.mjs`

- [ ] **Step 1: Write the failing test (append)**

```js
import { scanHeadings } from "../src/markdown.mjs";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/markdown.test.mjs`
Expected: FAIL — `scanHeadings is not exported`.

- [ ] **Step 3: Append implementation to `src/markdown.mjs`**

```js
export function scanHeadings(lines, bodyStartLineIdx) {
  const headings = [];
  let inFence = false;
  for (let i = bodyStartLineIdx; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), lineIdx: i });
  }
  return headings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/markdown.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/markdown.mjs test/markdown.test.mjs && git commit -m "feat(gtir): fence-aware ATX heading scanner"
```

---

## Task 3: `buildSections` + `sectionPrefix`

**Files:**
- Modify: `gtir/src/markdown.mjs`
- Test: `gtir/test/markdown.test.mjs`

- [ ] **Step 1: Write the failing test (append)**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/markdown.test.mjs`
Expected: FAIL — `buildSections is not exported`.

- [ ] **Step 3: Append implementation to `src/markdown.mjs`**

```js
export function buildSections(lines, headings, bodyStartLineIdx, root) {
  const sections = [];
  const firstHeadingLine = headings.length ? headings[0].lineIdx : lines.length;
  if (firstHeadingLine > bodyStartLineIdx) {
    sections.push({ breadcrumb: [root], startLineIdx: bodyStartLineIdx, endLineIdx: firstHeadingLine, headingOnly: false });
  }
  const stack = []; // [{level, title}]
  for (let h = 0; h < headings.length; h++) {
    const { level, title, lineIdx } = headings[h];
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const breadcrumb = [root, ...stack.map((s) => s.title), title];
    stack.push({ level, title });
    const endLineIdx = h + 1 < headings.length ? headings[h + 1].lineIdx : lines.length;
    let hasContent = false;
    for (let i = lineIdx + 1; i < endLineIdx; i++) { if (lines[i].trim()) { hasContent = true; break; } }
    sections.push({ breadcrumb, startLineIdx: lineIdx, endLineIdx, headingOnly: !hasContent });
  }
  return sections;
}

export function sectionPrefix(relPath, breadcrumb, tags) {
  const tagStr = tags && tags.length ? `  [tags: ${tags.join(", ")}]` : "";
  return `${relPath}${SEP}${breadcrumb.join(SEP)}${tagStr}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/markdown.test.mjs`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/markdown.mjs test/markdown.test.mjs && git commit -m "feat(gtir): section builder (breadcrumb stack) + prefix formatter"
```

---

## Task 4: `chunkMarkdown`

**Files:**
- Modify: `gtir/src/markdown.mjs`
- Test: `gtir/test/markdown.test.mjs`

- [ ] **Step 1: Write the failing test (append)**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/markdown.test.mjs`
Expected: FAIL — `chunkMarkdown is not exported`.

- [ ] **Step 3: Append implementation to `src/markdown.mjs`**

```js
export function chunkMarkdown(relPath, text, cfg) {
  const lines = text.split("\n");
  const lineStartChar = [0];
  for (let i = 0; i < lines.length; i++) lineStartChar.push(lineStartChar[i] + lines[i].length + 1);

  const fm = parseFrontmatter(lines);
  const root = fm.title || basename(relPath).replace(/\.(md|mdx)$/i, "");
  const headings = scanHeadings(lines, fm.bodyStartLineIdx);
  const sections = buildSections(lines, headings, fm.bodyStartLineIdx, root);

  const chunks = [];
  for (const sec of sections) {
    if (sec.headingOnly) continue;
    const body = lines.slice(sec.startLineIdx, sec.endLineIdx).join("\n").replace(/\s+$/, "");
    if (!body.trim()) continue;
    const prefix = sectionPrefix(relPath, sec.breadcrumb, fm.tags);
    const charStart = lineStartChar[sec.startLineIdx];
    const lineStart = sec.startLineIdx + 1;
    if (body.length <= cfg.maxChars) {
      chunks.push({
        path: relPath, language: "markdown",
        chunkStart: charStart, chunkEnd: charStart + body.length,
        lineStart, lineEnd: sec.startLineIdx + body.split("\n").length,
        text: body, prefix,
      });
    } else {
      // Reuse the recursive splitter on the section body; offset its positions
      // back to the original file and stamp the section's breadcrumb prefix.
      for (const s of chunkRecursive(relPath, "markdown", body, cfg)) {
        chunks.push({
          ...s,
          chunkStart: s.chunkStart + charStart,
          chunkEnd: s.chunkEnd + charStart,
          lineStart: s.lineStart + (lineStart - 1),
          lineEnd: s.lineEnd + (lineStart - 1),
          prefix,
        });
      }
    }
  }
  return chunks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/markdown.test.mjs` → PASS (12 tests).
Then full suite: `cd /g/demon/gtir && node --test`.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/markdown.mjs test/markdown.test.mjs && git commit -m "feat(gtir): chunkMarkdown — heading sections + breadcrumb prefix + oversize split"
```

---

## Task 5: integration — route `.md` and honor `prefix`

**Files:**
- Modify: `gtir/src/chunker.mjs` (`chunkFile`)
- Modify: `gtir/src/contextualize.mjs` (`contextualizeChunk`)
- Test: `gtir/test/chunker.test.mjs`, `gtir/test/contextualize.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `gtir/test/chunker.test.mjs` (reuse its existing `test`/`assert`/`chunkFile` imports):

```js
test("chunkFile routes .md through chunkMarkdown (chunks carry a prefix)", async () => {
  const md = "# Title\n\nSome real markdown content under a heading, long enough to be a chunk here.";
  const chunks = await chunkFile("notes/p.md", ".md", md, { maxChars: 2000, minChars: 20, overlapChars: 100 });
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].language, "markdown");
  assert.ok(chunks[0].prefix, "markdown chunk should carry a breadcrumb prefix");
  assert.match(chunks[0].prefix, /notes\/p\.md › Title/);
});
```

Append to `gtir/test/contextualize.test.mjs` (reuse its existing `test`/`assert`/`contextualizeChunk`/`syntheticPrefix` imports):

```js
test("contextualizeChunk honors a precomputed prefix (markdown chunks)", async () => {
  const c = { path: "p.md", text: "body text", prefix: "p.md › Title › Section" };
  const r = await contextualizeChunk(c, { contextTier: "synthetic" });
  assert.ok(r.embedText.startsWith("p.md › Title › Section\n"));
  assert.ok(r.embedText.includes("body text"));
  assert.equal(r.text, "body text"); // snippet stays raw
});

test("contextualizeChunk without prefix uses synthetic (code chunks unaffected)", async () => {
  const c = { path: "a.ts", text: "export function f() { return 1; }" };
  const r = await contextualizeChunk(c, { contextTier: "synthetic" });
  assert.ok(r.embedText.startsWith(syntheticPrefix(c)));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /g/demon/gtir && node --test test/chunker.test.mjs test/contextualize.test.mjs`
Expected: FAIL — `.md` currently routes to the recursive splitter (no `prefix`); `contextualizeChunk` ignores `chunk.prefix`.

- [ ] **Step 3a: Route markdown in `src/chunker.mjs`**

Add the import at the top of `src/chunker.mjs` (alongside the existing imports):

```js
import { chunkMarkdown } from "./markdown.mjs";
```

Replace the existing `chunkFile`:

```js
export async function chunkFile(relPath, ext, text, cfg) {
  const langId = langFor(ext);
  if (langId === null) return chunkRecursive(relPath, ext.replace(/^\./, ""), text, cfg);
  return chunkWithTreesitter(relPath, langId, text, cfg);
}
```

with:

```js
export async function chunkFile(relPath, ext, text, cfg) {
  const langId = langFor(ext);
  if (langId === "markdown") return chunkMarkdown(relPath, text, cfg);
  if (langId === null) return chunkRecursive(relPath, ext.replace(/^\./, ""), text, cfg);
  return chunkWithTreesitter(relPath, langId, text, cfg);
}
```

- [ ] **Step 3b: Honor `prefix` in `src/contextualize.mjs`**

Replace the existing `contextualizeChunk`:

```js
export async function contextualizeChunk(chunk, cfg) {
  const prefix = cfg.contextTier === "claude-cli" ? claudeCliPrefix(chunk) : syntheticPrefix(chunk);
  return { ...chunk, embedText: `${prefix}\n${chunk.text}` };
}
```

with:

```js
export async function contextualizeChunk(chunk, cfg) {
  // A chunk may carry a precomputed context prefix (e.g. the markdown chunker's
  // heading breadcrumb + tags). Honor it; otherwise fall back to the synthetic /
  // claude-cli prefix used for code chunks.
  const prefix = chunk.prefix ?? (cfg.contextTier === "claude-cli" ? claudeCliPrefix(chunk) : syntheticPrefix(chunk));
  return { ...chunk, embedText: `${prefix}\n${chunk.text}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /g/demon/gtir && node --test test/chunker.test.mjs test/contextualize.test.mjs` → PASS.
Then full suite: `cd /g/demon/gtir && node --test` (all green — confirms the circular import resolves and nothing else broke).

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/chunker.mjs src/contextualize.mjs test/chunker.test.mjs test/contextualize.test.mjs && git commit -m "feat(gtir): route markdown to chunkMarkdown; contextualize honors chunk prefix"
```

---

## Task 6: live validation + README

**Files:**
- Modify: `gtir/README.md`

Responsibility: prove the new chunker works end-to-end on a real vault and measure/inspect the quality change, then document that markdown is heading-aware.

- [ ] **Step 1: Rebuild the wiki index with the new chunker and inspect chunk quality**

Run (real Ollama; this re-embeds the wiki with heading-aware chunks):

```bash
gtir index --rebuild --repo G:/mediaTraktor/wiki
gtir search "how does the native desktop app host an MCP server" --repo G:/mediaTraktor/wiki -k 3
```

Expected: top hits are clean heading-bounded sections; confirm by spot-reading that snippets start at a heading and read as coherent sections (not mid-sentence char windows). Note the `score`/paths.

- [ ] **Step 2: Confirm breadcrumb prefixes are being embedded**

Write a one-off check (delete after) at `gtir/_probe_prefix.mjs`:

```js
import { chunkMarkdown } from "./src/markdown.mjs";
import { readFileSync } from "node:fs";
const text = readFileSync(process.argv[2], "utf8");
const chunks = chunkMarkdown("sample.md", text, { maxChars: 1500, minChars: 80, overlapChars: 200 });
for (const c of chunks.slice(0, 5)) console.log(c.prefix);
```

Run against a real multi-heading wiki page, e.g.:
```bash
cd /g/demon/gtir && node _probe_prefix.mjs "G:/mediaTraktor/wiki/decisions/ADR-0023 Native Desktop App as MCP Host.md"; rm -f _probe_prefix.mjs
```

Expected: printed prefixes show the breadcrumb trail (e.g. `… › ADR-0023 … › Decision › …`) and `[tags: …]` if the page has frontmatter tags.

- [ ] **Step 3: Update `README.md`**

In the "How it works" section, change the markdown line. Find:

```
  → tree-sitter AST chunks (+ cAST sibling-merge; recursive fallback for grammarless files)
```

and append a markdown note immediately after that line:

```
  → markdown: heading-aware sections, each carrying its heading breadcrumb + frontmatter tags
```

- [ ] **Step 4: Commit**

```bash
cd /g/demon/gtir && git add README.md && git commit -m "docs(gtir): note heading-aware markdown chunking"
```

> **Optional measured A/B (recommended if you want hard numbers):** reconstruct the
> known-item notes benchmark (a subagent generates paraphrased queries for ~18 wiki
> pages; run each through the new heading-aware index vs an index built from the prior
> commit's char-splitter) and report Recall@1/5/10 + MRR, plus a chunk-level signal
> (does the top chunk's breadcrumb match the target section?). This is the metric the
> change targets. It is not required to land the feature.

---

## Self-Review (against the spec)

**Spec coverage:**
- Hand-written fence-aware scanner → Task 2 (`scanHeadings`). ✅
- Section boundaries / heading-only skip / preamble → Task 3 (`buildSections`), Task 4 (emit). ✅
- Full breadcrumb into embed-text → Task 3 (`sectionPrefix`), Task 4 (`prefix`), Task 5 (`contextualize` honors it). ✅
- Frontmatter title (root) + tags (context), strip YAML → Task 1 (`parseFrontmatter`), Task 4 (root + tags in prefix). ✅
- Oversize split via `chunkRecursive`, short kept, heading-only skipped → Task 4. ✅
- `#` inside fences ignored → Task 2 (test + `inFence`). ✅
- Offsets map to original file → Task 4 (`lineStartChar`, offset of split sub-chunks; test asserts `chunkStart`/`lineStart`). ✅
- `chunkFile` routes `.md`; `contextualize` honors prefix → Task 5. ✅
- ATX-only / setext deferred → not implemented (documented spec limitation; no task needed). ✅
- Measured validation → Task 6 (live + optional A/B). ✅

**Placeholder scan:** No TBD/vague steps; every code step shows complete code. The probe in Task 6 Step 2 is created-and-deleted in the same command (not left behind).

**Type/name consistency:** chunk shape `{path, language:"markdown", chunkStart, chunkEnd, lineStart, lineEnd, text, prefix}` is produced in Task 4 and consumed by `contextualizeChunk` (`chunk.prefix`, `chunk.text`) in Task 5 and by `stableId` (unchanged). `parseFrontmatter` returns `{title, tags, aliases, bodyStartLineIdx}` — consumed consistently in Task 4 (`fm.title`, `fm.tags`, `fm.bodyStartLineIdx`). `scanHeadings(lines, bodyStartLineIdx)` and `buildSections(lines, headings, bodyStartLineIdx, root)` signatures match their call sites in `chunkMarkdown`. `SEP` constant used consistently in `sectionPrefix` and breadcrumb joins.
```
