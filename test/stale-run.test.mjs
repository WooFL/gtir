import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineQuery, checkQuery, ackQuery, muteQuery } from "../src/stale-run.mjs";

// A fake config whose gtirDir is a temp dir; an injected resolver stands in for the live index.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "stale-gtir-"));
  return { cfg: { gtirDir: dir }, code: { indexDir: "/code/.gtir" }, dir };
}

test("baseline writes the file at <gtirDir>/stale-baselines.json", async () => {
  const { cfg, code, dir } = setup();
  const links = { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s1", bodyHash: "b1", sig: "f()", snippet: "f() {" }] };
  const out = await baselineQuery(cfg, code, { resolve: async () => links });
  assert.equal(out.notes, 1);
  assert.equal(out.links, 1);
  assert.ok(existsSync(join(dir, "stale-baselines.json")));
  rmSync(dir, { recursive: true, force: true });
});

test("baseline -> check flags drift -> ack clears it", async () => {
  const { cfg, code, dir } = setup();
  const v1 = { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s1", bodyHash: "b1", sig: "f()", snippet: "f() {" }] };
  const v2 = { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s2", bodyHash: "b2", sig: "f(x)", snippet: "f(x) {" }] };

  await baselineQuery(cfg, code, { resolve: async () => v1 });
  const flagged = await checkQuery(cfg, code, { resolve: async () => v2 });
  assert.equal(flagged.staleNotes, 1);
  assert.equal(flagged.stale[0].rows[0].severity, "signature");

  const acked = await ackQuery(cfg, code, "a.md", { resolve: async () => v2 });
  assert.equal(acked.acked, "a.md");

  const clean = await checkQuery(cfg, code, { resolve: async () => v2 });
  assert.equal(clean.staleNotes, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("mute persists and suppresses a note's drift on the next check", async () => {
  const { cfg, code, dir } = setup();
  const v1 = { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s1", bodyHash: "b1", sig: "f()", snippet: "f() {" }] };
  const v2 = { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s2", bodyHash: "b2", sig: "f(x)", snippet: "f(x) {" }] };
  await baselineQuery(cfg, code, { resolve: async () => v1 });
  muteQuery(cfg, "a.md", "f");
  const out = await checkQuery(cfg, code, { resolve: async () => v2 });
  assert.equal(out.staleNotes, 0);
  rmSync(dir, { recursive: true, force: true });
});
