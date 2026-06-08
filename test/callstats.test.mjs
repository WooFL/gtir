import { test } from "node:test";
import assert from "node:assert/strict";
import { memberCallStats } from "../src/callstats.mjs";

// A minimal calls-row factory mirroring the in-memory resolved row shape (src/edges.mjs row()).
function call(over = {}) {
  return {
    kind: "calls", conf: "ambiguous",
    from_path: "a.ts", from_lines: "1", from_symbol: null,
    to_path: null, to_lines: null, to_symbol: null,
    ref_name: "m", candidates: [], content_hash: null, score: null,
    isMethod: true, receiverType: null, receiverFactory: null,
    enclosingClass: null, memberOp: null, receiver: "obj",
    ...over,
  };
}

// In-repo type/method sets the classifier consults for receiver-external / method-external.
// Encoder is an in-repo class with method `flush`; nothing else is in-repo.
const sets = {
  types: new Set(["Encoder"]),
  methods: new Map([["Encoder", new Set(["flush"])]]),
};

test("memberCallStats: resolved + dispatch land in the resolved bucket; rate is resolved/total", () => {
  const rows = [
    call({ conf: "resolved", ref_name: "flush", receiverType: "Encoder" }),
    call({ conf: "dispatch", ref_name: "area", receiverType: "Shape", candidates: ["a.ts", "b.ts"] }),
    call({ conf: "external", ref_name: "log", receiver: "console" }),
  ];
  const r = memberCallStats(rows, { sets });
  assert.equal(r.total_member_calls, 3);
  assert.equal(r.resolved, 2);            // resolved + dispatch
  assert.equal(r.external, 1);
  assert.equal(r.inferred, 0);
  assert.equal(r.rate, 2 / 3);
});

test("memberCallStats: inferred is counted separately (should not occur in collect mode)", () => {
  const rows = [call({ conf: "inferred", ref_name: "flush", receiverType: "Encoder", to_path: "encoder.ts" })];
  const r = memberCallStats(rows, { sets });
  assert.equal(r.total_member_calls, 1);
  assert.equal(r.inferred, 1);
  assert.equal(r.resolved, 0);
  assert.equal(r.rate, 0);
});

test("memberCallStats: ambiguous reasons classify first-match-wins", () => {
  const rows = [
    // no-enclosing-class: receiver present, receiverType null, no enclosing class.
    call({ conf: "ambiguous", receiver: "x", receiverType: null, enclosingClass: null, from_path: "n.cpp" }),
    // receiver-untyped: receiver present, receiverType null, BUT inside a class (enclosingClass set).
    call({ conf: "ambiguous", receiver: "y", receiverType: null, enclosingClass: "Holder", from_path: "u.cpp" }),
    // receiver-external: receiverType set but not in-repo.
    call({ conf: "ambiguous", receiver: "v", receiverType: "std::vector", ref_name: "push_back", from_path: "e.cpp" }),
    // method-external: receiverType in-repo, but method not defined on it in-repo.
    call({ conf: "ambiguous", receiver: "e", receiverType: "Encoder", ref_name: "nonexistent", from_path: "m.cpp" }),
    // multi-candidate: still ambiguous with >1 candidate.
    call({ conf: "ambiguous", receiver: "z", receiverType: "Encoder", ref_name: "flush",
      candidates: ["one.cpp", "two.cpp"], from_path: "c.cpp" }),
  ];
  const r = memberCallStats(rows, { sets });
  assert.equal(r.total_member_calls, 5);
  assert.equal(r.resolved, 0);
  assert.equal(r.by_reason["no-enclosing-class"], 1);
  assert.equal(r.by_reason["receiver-untyped"], 1);
  assert.equal(r.by_reason["receiver-external"], 1);
  assert.equal(r.by_reason["method-external"], 1);
  assert.equal(r.by_reason["multi-candidate"], 1);
  assert.equal(r.by_reason.other ?? 0, 0);
});

test("memberCallStats: an ambiguous row matching no reason falls to `other` (kept visible)", () => {
  // receiverType in-repo, method IS defined in-repo, single (or zero) candidate, but still ambiguous.
  const rows = [
    call({ conf: "ambiguous", receiver: "e", receiverType: "Encoder", ref_name: "flush",
      candidates: ["only.cpp"], from_path: "o.cpp" }),
  ];
  const r = memberCallStats(rows, { sets });
  assert.equal(r.by_reason.other, 1);
});

test("memberCallStats: non-method calls and non-call rows are ignored", () => {
  const rows = [
    call({ conf: "resolved", ref_name: "flush", receiverType: "Encoder" }),   // counted
    call({ isMethod: false, conf: "resolved", ref_name: "freeFn" }),          // NOT a member call → ignored
    { kind: "imports", conf: "resolved", isMethod: false, from_path: "a.ts" }, // not a call → ignored
    { kind: "links", conf: "external", isMethod: false, from_path: "a.md" },   // not a call → ignored
  ];
  const r = memberCallStats(rows, { sets });
  assert.equal(r.total_member_calls, 1);
  assert.equal(r.resolved, 1);
});

test("memberCallStats: by_lang splits by caller-file extension, same shape", () => {
  const rows = [
    call({ conf: "resolved", from_path: "a.cpp", receiverType: "Encoder", ref_name: "flush" }),
    call({ conf: "external", from_path: "b.cpp", receiver: "std" }),
    call({ conf: "resolved", from_path: "c.ts", receiverType: "Encoder", ref_name: "flush" }),
  ];
  const r = memberCallStats(rows, { sets });
  assert.ok(r.by_lang.cpp, "cpp bucket present");
  assert.ok(r.by_lang.ts, "ts bucket present");
  assert.equal(r.by_lang.cpp.total_member_calls, 2);
  assert.equal(r.by_lang.cpp.resolved, 1);
  assert.equal(r.by_lang.cpp.external, 1);
  assert.equal(r.by_lang.cpp.rate, 1 / 2);
  assert.equal(r.by_lang.ts.total_member_calls, 1);
  assert.equal(r.by_lang.ts.resolved, 1);
  assert.equal(r.by_lang.ts.rate, 1);
});

test("memberCallStats: lang filter restricts the population to one caller language", () => {
  const rows = [
    call({ conf: "resolved", from_path: "a.cpp", receiverType: "Encoder", ref_name: "flush" }),
    call({ conf: "resolved", from_path: "c.ts", receiverType: "Encoder", ref_name: "flush" }),
  ];
  const r = memberCallStats(rows, { sets, lang: "ts" });
  assert.equal(r.total_member_calls, 1);
  assert.equal(r.resolved, 1);
  // by_lang under a filter holds only the kept language.
  assert.ok(r.by_lang.ts);
  assert.equal(r.by_lang.cpp ?? undefined, undefined);
});

test("memberCallStats: empty input yields a zeroed report with rate 0 (no divide-by-zero)", () => {
  const r = memberCallStats([], { sets });
  assert.equal(r.total_member_calls, 0);
  assert.equal(r.resolved, 0);
  assert.equal(r.rate, 0);
  assert.deepEqual(r.by_lang, {});
});
