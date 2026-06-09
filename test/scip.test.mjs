import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScipRoot, parseScipIndex } from "../src/scip.mjs";

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
