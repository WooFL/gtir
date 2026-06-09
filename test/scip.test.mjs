import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScipRoot, parseScipIndex } from "../src/scip.mjs";
import { buildOracle } from "../src/scip.mjs";
import { scipCrossCheck, normPath } from "../src/scip-eval.mjs";

test("parseScipIndex decodes an encoded Index into a plain shape", () => {
  const root = loadScipRoot();
  const Index = root.lookupType("scip.Index");
  const payload = {
    documents: [
      {
        relativePath: "src/a.ts",
        occurrences: [
          { range: [4, 2, 4, 8], symbol: "A#m().", symbolRoles: 1 },
          { range: [9, 2, 9, 8], symbol: "A#m().", symbolRoles: 0 },
        ],
      },
    ],
  };
  assert.equal(Index.verify(payload), null);
  const buf = Index.encode(Index.fromObject(payload)).finish();

  const parsed = parseScipIndex(Buffer.from(buf), root);
  assert.equal(parsed.documents.length, 1);
  assert.equal(parsed.documents[0].path, "src/a.ts");
  assert.equal(parsed.documents[0].occurrences.length, 2);
  assert.deepEqual(parsed.documents[0].occurrences[0].range, [4, 2, 4, 8]);
  assert.equal(parsed.documents[0].occurrences[0].symbol, "A#m().");
  assert.equal(parsed.documents[0].occurrences[0].roles, 1);
  assert.equal(parsed.documents[0].occurrences[1].roles, 0);
});

test("buildOracle indexes definitions and classifies member references", () => {
  const index = {
    documents: [
      {
        path: "src/a.ts",
        occurrences: [
          { range: [4, 2, 4, 8], symbol: "pkg A#m().", roles: 1 }, // def of A#m (line 5)
          { range: [9, 2, 9, 8], symbol: "pkg A#m().", roles: 0 }, // ref -> in-repo def
          { range: [3, 0, 3, 1], symbol: "local 1", roles: 0 },    // local: skipped
        ],
      },
      {
        path: "src/b.ts",
        occurrences: [
          { range: [1, 0, 1, 5], symbol: "pkg B#n().", roles: 0 }, // ref, no def -> external
          { range: [7, 2, 7, 9], symbol: "pkg freeFn().", roles: 0 }, // no '#' -> skipped
        ],
      },
    ],
  };

  const oracle = buildOracle(index);
  assert.equal(oracle.defOf.size, 1);
  assert.deepEqual(oracle.defOf.get("pkg A#m()."), { file: "src/a.ts", startLine: 4 });

  assert.equal(oracle.memberRefs.length, 2);
  const [r0, r1] = oracle.memberRefs;
  assert.deepEqual(
    { file: r0.file, line: r0.line, method: r0.method },
    { file: "src/a.ts", line: 10, method: "m" },
  );
  assert.deepEqual(r0.defTarget, { file: "src/a.ts", startLine: 4 });
  assert.equal(r1.method, "n");
  assert.equal(r1.defTarget, null);
});

test("normPath normalizes slashes, ./ prefix, and case", () => {
  assert.equal(normPath(".\\Src\\A.TS"), "src/a.ts");
});

test("scipCrossCheck computes precision, recall, and buckets", () => {
  // Oracle hand-built (scipCrossCheck reads only memberRefs). 3 resolvable + 1 external.
  const oracle = {
    defOf: new Map(),
    memberRefs: [
      { file: "src/a.ts", line: 10, method: "m", symbol: "A#m", defTarget: { file: "src/a.ts", startLine: 4 } },
      { file: "src/c.ts", line: 20, method: "p", symbol: "C#p", defTarget: { file: "src/c.ts", startLine: 7 } },
      { file: "src/b.ts", line: 2,  method: "n", symbol: "B#n", defTarget: null },
      { file: "src/d.ts", line: 30, method: "q", symbol: "D#q", defTarget: { file: "src/d.ts", startLine: 3 } },
    ],
  };
  const edges = [
    // correct: repo-relative caller path suffix-matches package-relative SCIP path; def line 5 in 5-8
    { conf: "resolved", from_path: "packages/x/src/a.ts", from_lines: "10", ref_name: "m", to_path: "packages/x/src/a.ts", to_lines: "5-8" },
    // wrong: aligns to C#p but gtir points at the wrong file
    { conf: "resolved", from_path: "src/c.ts", from_lines: "20", ref_name: "p", to_path: "src/zzz.ts", to_lines: "1-9" },
    // external: aligns to B#n which has no in-repo def
    { conf: "resolved", from_path: "src/b.ts", from_lines: "2", ref_name: "n", to_path: "src/b.ts", to_lines: "1-3" },
    // unaligned: no SCIP ref for method r at e.ts
    { conf: "resolved", from_path: "src/e.ts", from_lines: "40", ref_name: "r", to_path: "src/e.ts", to_lines: "1-3" },
  ];

  const res = scipCrossCheck(edges, oracle, { sampleN: 10 });
  assert.equal(res.correct, 1);
  assert.equal(res.wrong, 1);
  assert.equal(res.external, 1);
  assert.equal(res.unaligned, 1);
  assert.equal(res.resolvableTotal, 3);
  assert.equal(res.precision, 0.5);          // 1 / (1 + 1)
  assert.ok(Math.abs(res.recall - 1 / 3) < 1e-9); // 1 correct / 3 resolvable
  // q was never attempted, p was wrong -> both appear as "missed" (not recalled)
  const missedMethods = res.samples.missed.map((x) => x.method).sort();
  assert.deepEqual(missedMethods, ["p", "q"]);
});
