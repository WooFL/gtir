import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";

test("crossLinkCap default exists", () => {
  assert.equal(DEFAULTS.crossLinkCap, 15);
});

import { crossLinks } from "../src/crosslinks.mjs";

// A fake code inventory: byName maps a defined symbol to its def site(s).
const inv = {
  byName: new Map([
    ["NodeTypeRegistry", [{ name: "NodeTypeRegistry", path: "packages/engine-core/src/node/registry.ts", line_start: 10, line_end: 40, text: "export class NodeTypeRegistry {\n  register() {}\n}" }]],
    ["fuseRRF", [{ name: "fuseRRF", path: "src/search.mjs", line_start: 58, line_end: 78, text: "export function fuseRRF(...) {}" }]],
  ]),
};
const files = new Set(["packages/engine-core/src/node/registry.ts", "src/search.mjs", "apps/web/main.ts"]);

test("crossLinks resolves real symbols + paths, ignores prose decoys", () => {
  const note = `This note discusses NodeTypeRegistry and the fuseRRF helper.
It references packages/engine-core/src/node/registry.ts directly.
It also mentions React, ADR-0004, Three.js, and Something — none of which are defined symbols.`;
  const links = crossLinks(inv, files, note, { cap: 15 });
  const syms = links.filter((l) => l.kind === "symbol").map((l) => l.symbol).sort();
  assert.deepEqual(syms, ["NodeTypeRegistry", "fuseRRF"]);
  assert.ok(links.some((l) => l.kind === "file" && l.path === "packages/engine-core/src/node/registry.ts"));
  assert.ok(!links.some((l) => l.symbol === "React" || l.symbol === "Something"));
  const reg = links.find((l) => l.symbol === "NodeTypeRegistry");
  assert.match(reg.snippet, /NodeTypeRegistry/);
  assert.equal(reg.lines, "10-40");
});

test("crossLinks respects the cap and dedups", () => {
  const note = "fuseRRF fuseRRF fuseRRF NodeTypeRegistry";
  const links = crossLinks(inv, files, note, { cap: 1 });
  assert.equal(links.length, 1);
});
