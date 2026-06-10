import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { snapshotRow } from "../src/stale.mjs";
import { syncQuery } from "../src/stale-run.mjs";

const BIN = fileURLToPath(new URL("../bin/gtir.mjs", import.meta.url));

function seed(baselineLinks) {
  const repo = mkdtempSync(join(tmpdir(), "gtir-sync-"));
  const gtirDir = join(repo, ".gtir");
  mkdirSync(gtirDir, { recursive: true });
  writeFileSync(join(gtirDir, "stale-baselines.json"),
    JSON.stringify({ version: 1, links: baselineLinks, muted: {} }, null, 2));
  return { repo, gtirDir, indexDir: join(gtirDir, "index.lance") };
}

const OLD_A = snapshotRow({ kind: "symbol", symbol: "alpha", path: "src/a.mjs", lines: "1-3", text: "function alpha(x) { return x; }" });
const OLD_B = snapshotRow({ kind: "symbol", symbol: "beta", path: "src/b.mjs", lines: "1-3", text: "function beta(y) { return y; }" });

test("syncQuery: signature drift auto-acked, body drift left flagged, table refreshed", async () => {
  const wikiCfg = seed({ "modules/m.md": [OLD_A, OLD_B] });
  const codeCfg = { indexDir: "x" };
  const NEW_A = snapshotRow({ kind: "symbol", symbol: "alpha", path: "src/a.mjs", lines: "1-3", text: "function alpha(x, z) { return x + z; }" });
  const NEW_B = snapshotRow({ kind: "symbol", symbol: "beta", path: "src/b.mjs", lines: "1-4", text: "function beta(y) { const t = y; return t; }" });
  const files = new Map([["modules/m.md", "# m\n\nDescribes `alpha` and `beta`.\n\n<!-- gtir:refs -->\nold\n<!-- /gtir:refs -->\n"]]);
  const out = await syncQuery(wikiCfg, codeCfg, {
    sha: "deadbee",
    deps: { resolve: async () => ({ "modules/m.md": [NEW_A, NEW_B] }), readNote: (p) => files.get(p) ?? null, writeNote: (p, t) => files.set(p, t) },
  });
  const note = out.synced.find((s) => s.note === "modules/m.md");
  assert.deepEqual(note.acked, ["alpha"]);
  assert.deepEqual(note.flagged, ["beta"]);
  assert.deepEqual(out.needsProse, ["modules/m.md"]);
  const text = files.get("modules/m.md");
  assert.match(text, /alpha\(x, z\)/);
  assert.match(text, /\[!warning\]/);
  assert.match(text, /stale: true/);
  assert.match(text, /last_synced_sha: deadbee/);
});

test("syncQuery: marker-less note is never patched by plain sync", async () => {
  const wikiCfg = seed({ "modules/plain.md": [OLD_A] });
  const codeCfg = { indexDir: "x" };
  const files = new Map([["modules/plain.md", "# plain\n\nno block here\n"]]);
  const out = await syncQuery(wikiCfg, codeCfg, {
    sha: "x",
    deps: { resolve: async () => ({ "modules/plain.md": [OLD_A] }), readNote: (p) => files.get(p) ?? null, writeNote: (p, t) => files.set(p, t) },
  });
  assert.equal(out.synced.length, 0);
  assert.equal(files.get("modules/plain.md"), "# plain\n\nno block here\n");
});

test("syncQuery --init seeds a refs block into a marker-less note", async () => {
  const wikiCfg = seed({ "modules/seed.md": [OLD_A] });
  const codeCfg = { indexDir: "x" };
  const files = new Map([["modules/seed.md", "# seed\n\ncites `alpha`.\n"]]);
  const out = await syncQuery(wikiCfg, codeCfg, {
    sha: "s1", init: true, notePath: "modules/seed.md",
    deps: { resolve: async () => ({ "modules/seed.md": [OLD_A] }), readNote: (p) => files.get(p) ?? null, writeNote: (p, t) => files.set(p, t) },
  });
  assert.match(files.get("modules/seed.md"), /<!-- gtir:refs -->/);
  assert.ok(out.synced.some((s) => s.note === "modules/seed.md"));
});

test("syncQuery: missing baseline => error", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-sync-nb-"));
  const wikiCfg = { repo, gtirDir: join(repo, ".gtir"), indexDir: join(repo, ".gtir", "index.lance") };
  const out = await syncQuery(wikiCfg, { indexDir: "x" }, { deps: { resolve: async () => ({}) } });
  assert.match(out.error, /no baseline/);
});

test("syncQuery: two file-kind refs in one note don't collide (no baseline cross-contamination)", async () => {
  const FA = snapshotRow({ kind: "file", path: "src/a.mjs", text: "AAA" });
  const FB = snapshotRow({ kind: "file", path: "src/b.mjs", text: "BBB" });
  const wikiCfg = seed({ "modules/f.md": [FA, FB] });
  const files = new Map([["modules/f.md", "# f\n\ncites files\n\n<!-- gtir:refs -->\n<!-- /gtir:refs -->\n"]]);
  await syncQuery(wikiCfg, { indexDir: "x" }, {
    sha: "s",
    deps: { resolve: async () => ({ "modules/f.md": [FA, FB] }), readNote: (p) => files.get(p) ?? null, writeNote: (p, t) => files.set(p, t) },
  });
  const baseline = JSON.parse(readFileSync(join(wikiCfg.gtirDir, "stale-baselines.json"), "utf8"));
  const rows = baseline.links["modules/f.md"];
  const a = rows.find((r) => r.path === "src/a.mjs"), b = rows.find((r) => r.path === "src/b.mjs");
  assert.ok(a && b, "both files present in baseline");
  assert.notEqual(a.bodyHash, b.bodyHash, "each file kept its OWN hash (no collision)");
});

test("CLI `gtir stale sync` errors clearly with no baseline (exit non-zero, JSON)", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-sync-cli-"));
  mkdirSync(join(repo, ".gtir"), { recursive: true });
  writeFileSync(join(repo, ".gtir", "config.json"), JSON.stringify({ model: "nomic-embed-text" }) + "\n");
  let stdout = "";
  try {
    stdout = execFileSync("node", [BIN, "stale", "sync", "--repo", repo, "--link-repo", repo, "--json"], { encoding: "utf8" });
  } catch (e) {
    stdout = (e.stdout || "") + (e.stderr || "");
  }
  assert.match(stdout, /no baseline|stale needs a code index/);
});
