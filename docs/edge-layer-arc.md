# Edge-Layer Arc — What we built, what improved, what's next

**Date:** 2026-06-07
**Scope:** Three sub-projects that turn gtir's edge layer from a 1-hop lookup into a queryable, search-integrated, embedding-fused graph. All merged to `main`. Tests **334 → 399** (+65). No new runtime dependencies.

---

## What we shipped

### A — Graph engine + analysis queries
The edge graph was only ever read 1 hop deep (`callers`/`callees`/`neighbors`). Now it's traversed.

- **`gtir impact <symbol>`** — transitive blast radius (who calls this, recursively). `--downstream` for dependencies, `--depth N`, `--path` to disambiguate a name in multiple files. Capped at 500 nodes (`--limit`, `truncated` flag).
- **`gtir orphans`** — likely-dead symbols (zero inbound edges). Real entrypoints (exports, `bin/`/`main`/`index`/`cli`, test files, Go-exported, handler names) split into a `possible_entrypoint` list, not flagged dead.
- **`gtir cycles`** — circular dependencies via Tarjan SCC: call cycles + import cycles, each with a sample path. Self-recursion excluded.
- Exposed on **both CLI and MCP** (`impact_<label>`, `orphans_<label>`, `cycles_<label>`).
- Traversal trusts **resolved edges only** by default; `--include-ambiguous` widens.

New: `src/edge-graph.mjs` (pure engine — `buildGraph`, `impact`, `cycles`, `orphans`, `degreeMap`), `src/graph-queries.mjs` (I/O), `store.allChunkRows`/`hasEdges`.
Key fix vs the old `buildAdjacency`: node identity is now precise (`path#symbol`), not bare name — two `parse`s in different files no longer collide.

### C — Graph-aware search
Folds the edge graph into retrieval. Both opt-in, query-time, cached in memory (no schema change).

- **`gtir search "<q>" --edges`** — attach each hit's `callers`/`callees`. One call returns the result *and* its neighborhood. `read_` takes `edges:true` too.
- **`gtir search "<q>" --centrality`** — gentle, bounded degree re-rank (≤ +15%); widely-called/imported code floats up. Off by default; skipped when reranking is on.

New: `src/graph-retrieval.mjs` (pure — `chunkCentrality`, `centralityMultiplier`, `applyCentrality`, `contextFor`), `graphForSearch` cache in `graph-queries.mjs`, config knobs `centralityWeight`/`centralityK`/`contextCap`.

### B — Embedding-disambiguation (the layer fusion)
The unique win: gtir is the only tool with both a call graph and per-chunk embeddings. We use one to repair the other.

- An `ambiguous` call edge (name matches several defs) is promoted to a new **`conf:"inferred"`** tier when the call-site chunk embedding is a confident cosine match to one candidate definition's embedding.
- Conservative thresholds (`disambigThreshold` 0.55, `disambigMargin` 0.05), default-on, **reuses vectors already in the store — zero new embedding calls**.
- Inferred edges traverse like resolved everywhere (callers/callees/impact/cycles/centrality/viz/eval), carry a cosine `score`, but stay a distinct tier so a proven edge reads differently from a guessed one.
- Persisted `score` column with a one-time **edge-schema heal** on upgrade.

New: `src/disambiguate.mjs` (pure — `cosine`, `disambiguateEdges`); wiring in `indexer.mjs`; `inferred` taught to `edge-graph.mjs`, `graph.mjs` (viz), `eval.mjs` (metrics).

---

## What improved (concretely)

- **The edge layer is now actionable, not just inspectable.** "What breaks if I change X", "what's dead", "what's circular" are one command each — for humans and for agents (MCP).
- **Agents get the neighborhood in one round-trip** (`--edges`) instead of search → callers → callees.
- **Ambiguous edges stopped being dead weight.** They were skipped by default and useless; now the confident ones become real, traversable, scored edges — improving impact/cycles/orphans recall and search context for free.
- **Node identity is correct** (`path#symbol`), fixing a latent same-name collision in the old adjacency.
- **Process quality:** every sub-project went brainstorm → spec → plan → subagent-driven build (implementer + spec-review + quality-review per task) → final whole-feature review. The final reviews caught two real cross-consumer gaps the specs missed — the graph-cache watch-invalidation parity (C) and the `inferred` tier being invisible/mis-rendered in `graph.mjs`/`eval.mjs` (B) — both fixed before merge.

---

## Known limitations (carried, from the reviews)

1. **Disambiguation thresholds are guessed, not tuned.** 0.55/0.05 are reasonable priors with no empirical validation on a real corpus.
2. **Incremental refresh doesn't re-disambiguate unchanged files.** A pre-existing `ambiguous` edge in a file you don't touch stays ambiguous until a `--rebuild` (the schema-heal rebuild is the only backstop). Acceptable but undocumented in user-facing terms.
3. **Graph caches are process-lifetime, invalidated only on watch refresh.** Matches the existing `adjCache`; a non-watch long-running MCP server could serve slightly stale graph data.
4. **Centrality is unmeasured.** We made it gentle and opt-in to be safe, but we never proved it helps (or doesn't hurt) retrieval on a golden set.
5. **`contextFor` output is thin** — `--edges` shows `{path, symbol}` only, not the edge `conf`/`score`, so you can't tell an inferred neighbor from a proven one in search output.
6. **Centrality nearest-chunk fallback** (when a call line falls outside every chunk interval — rare, line-window files) uses `line_start` distance, not midpoint. Low-frequency.
7. **Minor test gaps** flagged in review: `link_cycles` path, `contextFor` cap-stress, candidate-absent-from-symbolIndex.

---

## How to improve further (prioritized)

### High leverage
1. **Tune disambiguation empirically.** Build a golden set of known ambiguous→correct call mappings, then sweep `disambigThreshold`/`disambigMargin` with a harness like the existing fusion `gtir eval --tune`. Report precision/recall of promotions. Turns the guessed defaults into measured ones. *(touches `eval.mjs`, a new golden file)*
2. **Measure centrality's retrieval effect.** Extend the eval golden runner to compare `--centrality` on/off (and `--edges` context value). Either justify the default weight or auto-tune it. Without this, #4 above stays a hunch.
3. **Surface conf/score in `--edges` output.** Make `contextFor` carry `conf` (and `score` when inferred) per caller/callee, so agents see edge provenance inline. Small change to `graph-retrieval.mjs` + the MCP/CLI formatters.

### Medium
4. **`gtir path <A> <B>`** — shortest call path between two symbols (BFS over the graph already exists in `impact`; add a two-endpoint variant). Great for "how does A reach B" debugging, and a natural MCP tool.
5. **Re-disambiguate without full rebuild.** A `gtir refresh --redisambiguate` (or a maintenance pass) that re-scores all stored `ambiguous` edges using current embeddings — closes limitation #2 cheaply.
6. **Richer disambiguation signal.** Blend the cosine score with cheap structural priors: import-graph reachability (does the call-site file transitively import the candidate?), same-package proximity, arg-count match. Cosine alone is one signal; a tiny weighted blend would lift precision.
7. **Configurable orphan entrypoints.** The brainstorm's deferred option — let users declare entrypoint globs/names in config so odd codebases (frameworks, plugins) stop false-flagging.

### Lower / polish
8. **Viz: dashed inferred edges + a focus/path-highlight mode.** Inferred edges are now teal-toggleable; making them dashed (vs solid resolved) reads provenance at a glance. Click-to-highlight reachable subgraph was in the original viz brainstorm and never built.
9. **Persist degree/SCC** only if MCP `impact`/`cycles`/`centrality` become hot — measure first; today's rebuild is sub-ms.
10. **Close the minor test gaps** (#7 above).
11. **Calibrate the cosine score** into a 0–1 confidence (Platt-style) once a golden set exists, so `score` is interpretable as "probability this edge is right," not raw cosine.

### Operational
12. **Push to origin** — `main` is many commits ahead locally; nothing has been pushed.

---

## Field findings (measured on mediaTraktor + the gtir golden set)

Two of the backlog items above were investigated empirically. Both shipped to `main`.

### Finding 1 — disambiguation self-comparison artifact (improvement candidate #1)

Diagnosed on mediaTraktor (31,571 edges). Disambiguation is doing real work — it promoted **3,490 of 8,846 ambiguous calls (39%)**, more than doubling targeted call edges (resolved 3,050 → 6,540). Thresholds (0.55/0.05) are well-placed: the rejected pool's top-1 sims bulk at 0.3–0.6 (correctly murky), and loosening would mostly add method-name coincidences (`get`/`max`/`color` matching test-file decls).

But the **highest-confidence promotions were the least trustworthy**: 602 inferred edges scored ≈1.0, *all* same-file, because the call-site chunk **was** the candidate's def chunk — `cosine(chunk, itself) ≈ 1.0`, a degenerate signal. 446/602 targeted test files; names were `l`/`off`/`next`/`get`/`emit` (method calls colliding with a same-chunk decl).

**Fix shipped** (`fix(disambiguate): exclude self-chunk from candidate scoring`): skip any candidate def whose `content_hash` equals the call site's. Result on mediaTraktor: degenerate `score≥0.97` promotions **602 → 0**; net inferred 3,490 → 3,141 (349 correctly demoted to ambiguous, ~253 redirected to a real different-chunk target); score max 1.0 → 0.933. Different-chunk intra-file calls unaffected.

*Takeaway:* threshold tuning was the wrong lever; candidate-set quality (self-comparison, test-file pollution, method-name coincidences) is where disambiguation precision lives. Items #6 (structural priors) and a test-path demotion remain the next levers.

### Finding 2 — centrality re-rank hurts retrieval; tiebreaker form is neutral (improvement candidate #2)

Measured `--centrality` on the 110-query golden set (labeled) and on mediaTraktor (reorder magnitude).

The original **score-multiplier** form (×[1, 1.15] on RRF score, re-sort) **hurt**: recall@1 0.918 → **0.873 (−4.5pp)**, MRR 0.949 → 0.927, order changed on 91/110 queries; 50% top-1 flips on mediaTraktor. A degree multiplier competes too directly with relevance and demotes exact matches.

A first **broad tiebreaker** (reorder within RRF bands) was *worse* at eps 0.001 — recall@1 −25pp — because 0.001 exceeds the inter-rank RRF gap (~2.6e-4), merging the whole top of the list into one band.

**Fix shipped** (`fix(search): make --centrality tiebreaker-only`): reorder only within bands of *near-identical* RRF score (eps **1e-6**, far below the inter-rank gap), scores left unchanged, so an exact match can never be demoted. Re-measured: recall@1/@5/@10 and MRR **all unchanged vs off** (neutral); 16/110 genuine ties reordered toward central code; mediaTraktor top-1 flips **6/12 → 0/12**; still annotates 68/120 hits as central.

*Takeaway:* centrality is **not** a useful retrieval re-ranker on this data in any reordering-by-magnitude form. `--centrality` is now safe + informational: it breaks genuine RRF ties toward important code and tags central hits, without ever demoting a relevant result. The off-by-default decision was vindicated. A real win would require a different signal (e.g. learned blend) and labels on a connected codebase — not worth it now.

### Finding 3 — disambiguation precision is candidate-bound; a structural filter lifts it

Hand-labeled a stratified sample of 24 inferred edges on mediaTraktor: overall precision **~65%**, but only **~38%** in the 0.55–0.65 band (41% of all inferred). The dominant failure was **container/builtin method calls** — `obj.get()`, `.has()`, `.find()`, `mock()` — where the bare name coincidentally matches a same-named def elsewhere; the embedding scores them 0.55–0.83 (a `.get()` call site reads like a `get()` def) so the cosine threshold can't separate them. `Map.get` is wrong even at 0.83. Correct promotions were distinctive names (`recomputeFlagsAndMarkDirty`, `endFrame`, `vec`) or calls where the receiver genuinely *is* the target API (`api.delete`). Conclusion: threshold tuning is the wrong lever — candidate-set quality is.

**Fix shipped** (`feat: structural filter`): `extractCodeEdges` tags each call with `isMethod` (callee is a value member expression); `disambiguateEdges` refuses to promote a call that is **both** a member-call **and** a denylisted container/builtin/test name (get/set/has/find/map/mock/…), leaving it `ambiguous`. The flag is transient (never persisted — no schema change). Re-measured on mediaTraktor: inferred **3,141 → 2,662** (−479 member-call coincidences, degraded to `ambiguous` not traversed by default); the 0.55–0.65 band went from `mock`/`has`/`get`/`find` (all wrong) to distinctive names (`setNodePositions`→mutations, `canRedo`→history, `setNodeParam`→mutations, `dispose`→scriptCompileClient) — eyeball precision ~38% → ~65%.

*Takeaway:* the embedding can't fix a wrong candidate set; syntactic structure (is this a method call on a generic object?) can. Remaining false positives are now a smaller, different class — **bare** denylisted calls (`mock()` as a free import) and **test-file targets** — addressable by the next levers (bare-call handling, test-path candidate demotion), not this filter.

### Finding 4 — `gtir orphans` was ~95% noise; callable-only inventory fixed it

`gtir orphans` reported **4,136** likely_dead on mediaTraktor; characterization showed **~95% were non-callable declarations** — `type`/`interface`/`enum` and local value bindings (`const id = …`, `let result = …`) — which can never have an inbound *call* edge, so they all read as dead. Root cause: orphans reused `declaredSymbols` (built for the symbol *index*, where over-capturing is correct) as its definition inventory. Secondary cause: methods called only via `obj.method()` have **ambiguous-only** inbound (gtir can't resolve method receivers), so even real callables were flagged.

**Fix shipped** (`feat: orphans precision`): a new `declaredCallables(text)` (functions/classes/methods/function-valued bindings only — drops types and plain `const`/`let`/`var`) feeds an orphans-only inventory; `orphansQuery` always builds its inbound graph with ambiguous edges included, so a method that is a candidate of any ambiguous call to its name counts as referenced. `declaredSymbols`/`impact` keep the full inventory. Both changes move strictly toward fewer false positives (inventory shrinks, graph grows). Re-measured: likely_dead **4,136 → 288 (−93%)**, now dominated by real callables (`windowClosed`, `SettingsModal`, `start`).

*Takeaway:* dead-code detection needs a *callable* inventory, not every declared name; and on a language without resolvable method dispatch, ambiguous inbound must count as "used." Residual false positives are a new, smaller class — **JSX components** (`<Editor/>` usage isn't a call edge) and functions **re-exported separately** (`export { Editor }` defeats the inline-export entrypoint heuristic) — needing JSX-element edge extraction and better export detection.

### Cross-check — does bad-edge pollution corrupt the graph queries?

Ran `gtir cycles`/`gtir impact` on mediaTraktor to test the downstream impact of the ~65% inferred precision. **Phantom cycles confirmed but rare:** of 2 call cycles, 1 was inferred-dependent (a fake `canonicalize ↔ canonicalize` loop across two packages from a wrong inferred edge); the real one (`migrate.ts` mutual recursion) held under resolved-only. The structural filter doesn't catch this (`canonicalize` is distinctive, a cross-package coincidence) — the lever is an **import-reachability prior** (only promote a cross-file inferred edge if the call-site file transitively imports the candidate). Low absolute volume here, but it's a concrete instance of the precision problem reaching a query.

### Finding 5 — import-reachability prior: kills phantoms, but recall-costly on monorepos

`resolveEdges` already does *named*-import vouching (matching name+file → `resolved`), so ambiguous = no named-import match. But every relative import also emits a file-level `imports` edge (`to_path` = stem). **Fix shipped** (`feat: import-reachability prior`): before embedding-scoring an ambiguous call's candidates, drop any that are neither same-file nor directly imported by the call-site file (hard pre-filter; none eligible → stay ambiguous). The indexer builds the `from_path → {imported stems}` map; `disambiguateEdges` filters on it.

Re-measured on mediaTraktor: the phantom `canonicalize ↔ canonicalize` cycle is **gone** (call_cycles 2 → 1, only the real `migrate.ts` recursion). But inferred dropped **2,662 → 1,293 (−51%)** — the survivors are all import-reachable (high precision), while the removed split into genuine cross-file coincidences *and* legit cross-**package** calls via bare `@pkg/…` specifiers, which gtir doesn't resolve to an edge → those candidates look unreachable → stay ambiguous (safe direction, never wrong). For impact/cycles/orphans, precision ≫ recall, so a smaller import-vouched inferred set is the right trade; the dropped edges degrade to `ambiguous` (not traversed), never to wrong edges.

*Takeaway:* import-reachability is a strong correctness signal but only as good as import resolution — gtir's relative-only resolution makes it aggressive on monorepos. **Next lever:** resolve tsconfig `paths` / `package.json` so `@pkg/…` imports become edges, recovering the cross-package legit calls the prior currently can't see.
