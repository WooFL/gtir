// SCIP (.scip protobuf) decode + ground-truth oracle. Pure given the proto root.
// scip-typescript output is consumed read-only; we never run the indexer here.
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";

const DEFAULT_PROTO = fileURLToPath(new URL("../eval/scip/scip.proto", import.meta.url));

// Load the vendored proto once per call site. (Reading the .proto is the only
// impure bit in this module; isolated here so parse/build stay pure.)
export function loadScipRoot(protoPath = DEFAULT_PROTO) {
  return protobuf.loadSync(protoPath);
}

// Decode a .scip buffer into a plain, protobufjs-free shape:
//   { documents: [ { path, occurrences: [ { range:number[], symbol, roles } ] } ] }
export function parseScipIndex(buffer, root) {
  const Index = root.lookupType("scip.Index");
  const obj = Index.toObject(Index.decode(buffer), { defaults: true, arrays: true });
  return {
    documents: (obj.documents ?? []).map((d) => ({
      path: d.relativePath ?? "",
      occurrences: (d.occurrences ?? []).map((o) => ({
        range: o.range ?? [],
        symbol: o.symbol ?? "",
        roles: o.symbolRoles ?? 0,
      })),
    })),
  };
}

const DEFINITION = 0x1; // SymbolRole.Definition bit
const METHOD_RE = /([A-Za-z0-9_$]+)\(\)\.\s*$/; // captures the method name before "()."

// Build the oracle from a parsed index:
//   defOf:      Map<symbol, { file, startLine }>  (first Definition occurrence per symbol)
//   memberRefs: [{ file, line(1-based), method, symbol, defTarget|null }] for instance-member
//               call references (symbol contains '#', ends '().', not a local, not a definition).
//   defTarget !== null  ⟺  the call points to an in-repo definition (the recall denominator).
export function buildOracle(index) {
  const defOf = new Map();
  for (const doc of index.documents) {
    for (const occ of doc.occurrences) {
      if (occ.symbol && (occ.roles & DEFINITION) === DEFINITION && !defOf.has(occ.symbol)) {
        defOf.set(occ.symbol, { file: doc.path, startLine: occ.range?.[0] ?? 0 });
      }
    }
  }
  // memberRefs = instance-method CALL references only (symbol has '#', ends '().').
  // This deliberately matches gtir's call graph, which tracks method calls — NOT
  // property reads. So symbols like `Foo#bar.` (no parens) are excluded by design.
  // Caveat: getter/setter symbols (`Foo#get bar().`) DO end in '().' and so are
  // included here even though their source access has no parens; if engine-core
  // uses many accessors they may surface as `missed` in the cross-check (gtir has
  // no call edge for them) — inspect the `missed` samples rather than assuming a bug.
  const memberRefs = [];
  for (const doc of index.documents) {
    for (const occ of doc.occurrences) {
      const sym = occ.symbol;
      if (!sym || sym.startsWith("local ")) continue;
      if ((occ.roles & DEFINITION) === DEFINITION) continue;
      if (!sym.includes("#")) continue;
      const m = sym.match(METHOD_RE);
      if (!m) continue;
      memberRefs.push({
        file: doc.path,
        line: (occ.range?.[0] ?? 0) + 1,
        method: m[1],
        symbol: sym,
        defTarget: defOf.get(sym) ?? null,
      });
    }
  }
  return { defOf, memberRefs };
}
