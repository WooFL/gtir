import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitBriefs, checkQuery } from "../src/stale-run.mjs";

const REPORT = {
  stale: [{
    note: "modules/cook-cycle.md",
    rows: [{
      symbol: "propagate", codePath: "packages/engine-core/src/cook.ts", lines: "40-72",
      severity: "signature", priority: "high",
      before: { sig: "propagate(node): void", snippet: "propagate(node) {", lines: "40-72" },
      after: { sig: "propagate(node, epoch): void", snippet: "propagate(node, epoch) {", lines: "41-74" },
    }],
  }],
  staleNotes: 1, staleLinks: 1,
};

test("emitBriefs writes one brief per stale note with the right shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  const written = emitBriefs(REPORT, dir, { sha: "deadbeef" });
  assert.equal(written.length, 1);
  const body = readFileSync(join(dir, written[0]), "utf8");
  assert.match(body, /reason: code-drift/);
  assert.match(body, /priority: high/);
  assert.match(body, /packages\/engine-core\/src\/cook\.ts/);
  assert.match(body, /propagate\(node\): void/);          // BEFORE
  assert.match(body, /propagate\(node, epoch\): void/);   // NOW
  assert.match(body, /gtir stale ack "modules\/cook-cycle\.md"/);
  rmSync(dir, { recursive: true, force: true });
});

test("emitBriefs renders a file-kind row without leaking undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  const report = {
    stale: [{
      note: "modules/@engine-nodes.md",
      rows: [{
        symbol: undefined, codePath: "packages/engine-nodes/src/index.ts", lines: undefined,
        severity: "body", priority: "medium",
        before: { sig: undefined, snippet: "import …", lines: undefined },
        after: { sig: undefined, snippet: "import …", lines: undefined },
      }],
    }],
    staleNotes: 1, staleLinks: 1,
  };
  const written = emitBriefs(report, dir, { sha: "abc123" });
  const body = readFileSync(join(dir, written[0]), "utf8");
  assert.doesNotMatch(body, /undefined/);                          // no leaked undefined anywhere
  assert.doesNotMatch(body, /index\.ts:undefined/);                // no ":undefined" line ref
  assert.match(body, /packages\/engine-nodes\/src\/index\.ts/);    // the file path is shown
  rmSync(dir, { recursive: true, force: true });
});

test("emitBriefs dedupes a second call for the same note", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  emitBriefs(REPORT, dir, { sha: "deadbeef" });
  const second = emitBriefs(REPORT, dir, { sha: "deadbeef" });
  assert.equal(second.length, 0);
  assert.equal(readdirSync(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("checkQuery returns no-baseline error when baseline file is absent", async () => {
  const wikiDir = mkdtempSync(join(tmpdir(), "wiki-"));
  const cfg = { gtirDir: wikiDir };
  const out = await checkQuery(cfg, {}, { resolve: async () => ({}) });
  assert.match(out.error, /no baseline/);
  rmSync(wikiDir, { recursive: true, force: true });
});

test("checkQuery diffs an injected current resolution against the baseline file", async () => {
  const wikiDir = mkdtempSync(join(tmpdir(), "wiki-"));
  const cfg = { gtirDir: wikiDir };
  writeFileSync(join(wikiDir, "stale-baselines.json"), JSON.stringify({
    version: 1,
    links: { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s1", bodyHash: "b1", sig: "f()", snippet: "f() {" }] },
    muted: {},
  }));
  const current = { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s2", bodyHash: "b2", sig: "f(x)", snippet: "f(x) {" }] };
  const out = await checkQuery(cfg, {}, { resolve: async () => current });
  assert.equal(out.staleNotes, 1);
  assert.equal(out.stale[0].rows[0].severity, "signature");
  rmSync(wikiDir, { recursive: true, force: true });
});
