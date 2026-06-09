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
