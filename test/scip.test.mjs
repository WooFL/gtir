import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScipRoot, parseScipIndex } from "../src/scip.mjs";
import { buildOracle } from "../src/scip.mjs";

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
