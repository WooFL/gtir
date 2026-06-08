#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { search } from "../src/search.mjs";
import { embedTexts } from "../src/embed.mjs";
import { gridCombos, parseGridSpec, sweepWeights, rankSweep, defaultObjective, weightsKey } from "../src/sweep.mjs";
import { openStore } from "../src/store.mjs";
import { installHook, removeHook, gitBusy } from "../src/hook.mjs";
import { watchRepo, watcherLive } from "../src/watch.mjs";
import { probeDim } from "../src/embed.mjs";
import { runInit, ensureGitignore } from "../src/init.mjs";
import { resolveIndexes, serveStdio, printConfig, startWatchers, preflightIndexes } from "../src/mcp.mjs";
import { evalGolden, flattenMetrics, compareBaseline, compareTiers, evalEdgeExtraction, evalDisambiguation, rankDisambigOperatingPoint, evalOrphans } from "../src/eval.mjs";
import { disambiguateEdges } from "../src/disambiguate.mjs";
import { declaredSymbols } from "../src/symbols.mjs";
import { runDemo, formatDemo } from "../src/demo.mjs";
import { runDoctor, preflight } from "../src/doctor.mjs";
import { indexEdges } from "../src/indexer.mjs";
import { memberCallStats } from "../src/callstats.mjs";
import { fetchGrammars } from "../src/fetch-grammars.mjs";
import { buildGraph, renderHtml, renderMermaid } from "../src/graph.mjs";
import { impactQuery, orphansQuery, cyclesQuery, graphForSearch, buildSymbolInventory } from "../src/graph-queries.mjs";
import {
  gtirMcpEntry, gtirHookEntry, gtirClaudeMdBody,
  addMcpServer, removeMcpServer, addPreToolUseHook, removePreToolUseHook,
  upsertMarkedSection, removeMarkedSection, hooknudge,
  GTIR_START, GTIR_END, HOOK_MATCH_KEY,
} from "../src/install.mjs";
import { pathBetween, buildGraph as buildEdgeGraph, nodeKey } from "../src/edge-graph.mjs";
import { mkdirSync } from "node:fs";

// --- programmatic entrypoints (used by tests and the dispatcher) ---

function pkgVersion() {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; }
  catch { return "0.0.0"; }
}

export async function runIndex({ repo, rebuild = false, noCache = false, embedImpl = null, preflight: doPreflight = false, fetchImpl = null } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
  if (fetchImpl) cfg.fetchImpl = fetchImpl;
  cfg.noCache = noCache ?? cfg.noCache ?? false;
  // Preflight only the interactive `gtir index` path. The post-commit hook, `refresh`, and the
  // watcher call runIndex WITHOUT preflight so a momentarily-busy daemon never hard-blocks a commit.
  // Skip when a custom embed backend is injected (not Ollama) or the user disabled warmupOnStart.
  if (doPreflight && cfg.warmupOnStart && !cfg.embedImpl) {
    await preflight(cfg);
  }
  return buildIndex(cfg, { rebuild });
}

export async function runSearch({ repo, query, k = 8, pathPrefix = null, language = null, embedImpl = null, rerank = false, centrality = false, edges = false } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
  if (rerank) cfg.rerank = true;
  const graphData = (centrality || edges) ? await graphForSearch(cfg) : null;
  return search(query, cfg, { k, pathPrefix, language, centrality, edges, graphData });
}

export async function runStatus({ repo } = {}) {
  const cfg = loadConfig(repo);
  const store = await openStore(cfg);
  const meta = await store.readMeta();
  const man = await store.loadManifest();
  return { repo: cfg.repo, indexDir: cfg.indexDir, files: Object.keys(man).length, ...meta };
}

export async function runImpact({ repo, symbol, path = null, downstream = false, depth, includeAmbiguous = false, limit } = {}) {
  return impactQuery(loadConfig(repo), { symbol, path, downstream, depth, includeAmbiguous, limit });
}

// Shortest call-path between two symbols. Mirrors runImpact: loads edges + buildEdgeGraph, resolves
// symbol names to node keys using the same inventory mechanism impactQuery uses.
// Returns { path: string[]|null } on success, or { error: string } for missing symbols/index.
export async function runPath({ repo, from, to, fromPath = null, toPath = null, depth, includeAmbiguous = false } = {}) {
  if (!from) return { error: "from symbol is required" };
  if (!to) return { error: "to symbol is required" };
  const cfg = loadConfig(repo);
  const store = await openStore(cfg);
  const { isNotesMode } = await import("../src/search.mjs");
  const mode = isNotesMode(cfg) ? "notes" : "code";
  const hasEdges = await store.hasEdges();
  if (!hasEdges) return { error: "no edge index — run: gtir index" };
  const edges = await store.loadEdges();
  const graph = buildEdgeGraph(edges, { includeAmbiguous });
  const inv = await buildSymbolInventory(store, mode);
  // Resolve 'from' symbol — same mechanism as impactQuery
  let fromSites = inv.byName.get(from) || [];
  if (fromPath) fromSites = fromSites.filter((s) => s.path.includes(fromPath));
  if (fromSites.length === 0) return { error: `symbol '${from}' not found` };
  // Resolve 'to' symbol
  let toSites = inv.byName.get(to) || [];
  if (toPath) toSites = toSites.filter((s) => s.path.includes(toPath));
  if (toSites.length === 0) return { error: `symbol '${to}' not found` };
  const fromKeys = fromSites.map((s) => nodeKey(s.path, s.name || null));
  const toKeys = new Set(toSites.map((s) => nodeKey(s.path, s.name || null)));
  const maxDepth = Number.isFinite(depth) ? depth : Infinity;
  const foundPath = pathBetween(graph, fromKeys, toKeys, { maxDepth });
  return { from, to, path: foundPath };
}
export async function runOrphans({ repo } = {}) {
  return orphansQuery(loadConfig(repo));
}
export async function runCycles({ repo, includeAmbiguous = false } = {}) {
  return cyclesQuery(loadConfig(repo), { includeAmbiguous });
}

export async function runSetup({ repo } = {}) {
  const cfg = loadConfig(repo);
  const dim = await probeDim(cfg); // throws a remediation message if Ollama/model missing
  return { model: cfg.model, ollamaUrl: cfg.ollamaUrl, dim };
}

export async function runGraph({ repo, out = null, format = "html", focus = null, depth = 2, rollup = false,
  maxNodes = Infinity, kind = null, conf = null, pathPrefix = null, edgesImpl = null } = {}) {
  const cfg = loadConfig(repo);
  const edges = edgesImpl ? await edgesImpl() : await (await openStore(cfg)).loadEdges();
  if (!edges.length) throw new Error("no edge index — run 'gtir index' first");

  const graph = buildGraph(edges, { focus, depth, rollup, maxNodes, kind, conf, pathPrefix });
  if (focus && graph.nodes.length === 0) throw new Error(`no symbol matching '${focus}' in the edge graph`);

  const meta = { truncated: graph.truncated, dropped: graph.dropped };

  if (format === "mermaid") {
    const mmd = renderMermaid({ nodes: graph.nodes, edges: graph.edges, meta });
    const dest = out ?? "gtir-graph.mmd";
    if (dest === "-") {
      process.stdout.write(mmd + "\n");
    } else {
      writeFileSync(dest, mmd + "\n");
    }
    return { out: dest, nodes: graph.nodes.length, edges: graph.edges.length, truncated: graph.truncated, dropped: graph.dropped };
  }

  // Default: HTML format.
  const cosmosPath = fileURLToPath(new URL("../vendor/cosmos.min.js", import.meta.url));
  let cosmosSource;
  try { cosmosSource = readFileSync(cosmosPath, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") throw new Error(`missing vendored cosmos at ${cosmosPath} — run 'npm run bundle:cosmos'`);
    throw new Error(`cannot read vendored cosmos at ${cosmosPath}: ${e.message}`);
  }

  const dest = out ?? "gtir-graph.html";
  const html = renderHtml({ nodes: graph.nodes, edges: graph.edges, meta }, cosmosSource);
  writeFileSync(dest, html);
  return { out: dest, nodes: graph.nodes.length, edges: graph.edges.length, truncated: graph.truncated, dropped: graph.dropped };
}

// `gtir callstats --repo <path> [--json] [--lang <id>]`: report member-call resolution coverage over
// a repo. Builds the index (Ollama needed for the chunk embeddings buildIndex writes), then runs the
// indexEdges collect seam (full resolver chain, no disambiguate/embedding tier, no persist) and feeds
// the in-memory rows + in-repo type/method sets to the pure memberCallStats classifier. Deterministic:
// the resolution rate (resolved+dispatch / total member-calls) is exactly the receiver-type arc's reach.
// Prints a readable table to stderr; --json writes the report object to stdout. Returns an exit code.
export async function runCallstats({ repo, json = false, lang = null, embedImpl = null } = {}) {
  const root = repo || process.cwd();
  const cfg = loadConfig(root);
  if (embedImpl) cfg.embedImpl = embedImpl;
  // Build the index first: the collect seam reads the persisted chunks the resolver indexes need.
  await buildIndex(cfg, { rebuild: true });
  const { rows, sets } = await indexEdges(cfg, { rebuild: true, collect: true });
  const report = memberCallStats(rows, { sets, lang: lang ?? undefined });
  printCallstats(report, { repo: cfg.repo, lang });
  if (json) process.stdout.write(JSON.stringify(report) + "\n");
  return 0;
}

function printCallstats(r, { repo, lang } = {}) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const out = [`callstats: ${repo}${lang ? ` (lang=${lang})` : ""}`];
  out.push(`  member calls: ${r.total_member_calls}`);
  out.push(`  resolved (resolved+dispatch): ${r.resolved}  rate=${pct(r.rate)}`);
  out.push(`  external: ${r.external}   inferred: ${r.inferred}`);
  out.push("  unresolved by reason:");
  for (const [reason, n] of Object.entries(r.by_reason)) {
    if (n > 0) out.push(`    ${reason.padEnd(20)} ${n}`);
  }
  const langs = Object.keys(r.by_lang).sort();
  if (langs.length) {
    out.push("  by lang:");
    for (const l of langs) {
      const b = r.by_lang[l];
      out.push(`    ${l.padEnd(5)} n=${String(b.total_member_calls).padStart(5)} resolved=${String(b.resolved).padStart(5)} rate=${pct(b.rate)}`);
    }
  }
  process.stderr.write(out.join("\n") + "\n");
}

// `gtir install [--repo <path>] [--uninstall]`: wire a repo so Claude Code (main agent
// AND subagents) prefers gtir's MCP tools over raw Grep/Glob. Writes three merge-preserving,
// idempotent targets via the pure helpers in src/install.mjs:
//   <repo>/.mcp.json              — add mcpServers.gtir (this bin, `mcp --repo . --watch`)
//   <repo>/.claude/settings.json  — add a Grep|Glob PreToolUse hook → `gtir hooknudge`
//   <repo>/CLAUDE.md              — upsert a marked section nudging the MCP tools
// --uninstall calls the remove* counterparts. Tolerant of missing files (starts from {}/"")
// and never deletes a file on uninstall (leaves {}/empty). Returns a summary of changes.
export function runInstall({ repo = process.cwd(), uninstall = false, log = (m) => process.stderr.write(m + "\n") } = {}) {
  const absBin = fileURLToPath(import.meta.url); // the real path to this bin/gtir.mjs

  const readJson = (file) => {
    if (!existsSync(file)) return {};
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch { return {}; } // tolerate a malformed/empty file by starting fresh
  };
  const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
  const writeJson = (file, obj) => writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");

  const mcpFile = path.join(repo, ".mcp.json");
  const claudeDir = path.join(repo, ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const claudeMdFile = path.join(repo, "CLAUDE.md");

  // On uninstall we must not litter: if a target file was absent there is nothing of ours
  // to remove, so don't create an empty `{}`/empty file (or the `.claude/` dir) for it. If
  // it existed, write the cleaned result as before (even an empty `{}`/"" — never delete it).
  // Install (non-uninstall) always creates the files.
  const mcpExisted = existsSync(mcpFile);
  const settingsExisted = existsSync(settingsFile);
  const claudeMdExisted = existsSync(claudeMdFile);

  // .mcp.json
  if (!uninstall || mcpExisted) {
    const mcp0 = readJson(mcpFile);
    const mcp1 = uninstall
      ? removeMcpServer(mcp0, "gtir")
      : addMcpServer(mcp0, "gtir", gtirMcpEntry(absBin));
    writeJson(mcpFile, mcp1);
  }

  // .claude/settings.json
  if (!uninstall || settingsExisted) {
    mkdirSync(claudeDir, { recursive: true }); // only create .claude/ when we're actually writing settings
    const settings0 = readJson(settingsFile);
    const settings1 = uninstall
      ? removePreToolUseHook(settings0, HOOK_MATCH_KEY)
      : addPreToolUseHook(settings0, gtirHookEntry(absBin), HOOK_MATCH_KEY);
    writeJson(settingsFile, settings1);
  }

  // CLAUDE.md
  if (!uninstall || claudeMdExisted) {
    const md0 = readText(claudeMdFile);
    const md1 = uninstall
      ? removeMarkedSection(md0, GTIR_START, GTIR_END)
      : upsertMarkedSection(md0, GTIR_START, GTIR_END, gtirClaudeMdBody());
    writeFileSync(claudeMdFile, md1);
  }

  const verb = uninstall ? "removed" : "wired";
  log(`gtir install: ${verb} gtir for Claude Code in ${repo}`);
  log(`  .mcp.json              ${uninstall ? "- gtir server removed" : "+ gtir MCP server"}`);
  log(`  .claude/settings.json  ${uninstall ? "- Grep|Glob hook removed" : "+ Grep|Glob → hooknudge"}`);
  log(`  CLAUDE.md              ${uninstall ? "- gtir section removed" : "+ gtir nav nudge"}`);
  return { repo, uninstall, files: { mcp: mcpFile, settings: settingsFile, claudeMd: claudeMdFile } };
}

// --- argv parsing ---

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rebuild") args.rebuild = true;
    else if (a === "--repo") { const v = argv[++i]; args.repo = v; (args.repos ??= []).push(v); }
    else if (a === "--label") {
      const v = argv[++i] ?? "";
      const c = v.indexOf(":");
      if (c > 0) { (args.labels ??= {})[v.slice(c + 1)] = v.slice(0, c); }
    }
    else if (a === "--print-config") args.printConfig = true;
    else if (a === "--query") args.query = argv[++i];
    else if (a === "--grep-term") args.grepTerm = argv[++i];
    else if (a === "--no-color") args.noColor = true;
    else if (a === "--no-pull") args.noPull = true;
    else if (a === "-k" || a === "--k") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && Number.isFinite(Number(next))) {
        args.k = Number(next); i++;
      }
      // missing/non-numeric value: leave args.k unset; search falls back to default
    }
    else if (a === "--path-prefix") args.pathPrefix = argv[++i];
    else if (a === "--language") args.language = argv[++i];
    else if (a === "--lang") args.lang = argv[++i];
    else if (a === "--remove") args.remove = true;
    else if (a === "--uninstall") args.uninstall = true;
    else if (a === "--notes") args.notes = true;
    else if (a === "--code") args.code = true;
    else if (a === "--no-cache") args.noCache = true;
    else if (a === "--no-index") args.noIndex = true;
    else if (a === "--no-hook") args.noHook = true;
    else if (a === "--hook") args.hook = true;
    else if (a === "--watch") args.watch = true;
    else if (a === "--debounce") { const v = Number(argv[++i]); if (Number.isFinite(v)) args.debounce = v; }
    else if (a === "--sweep") { const v = Number(argv[++i]); if (Number.isFinite(v)) args.sweep = v; }
    else if (a === "--tune") { args.tune = true; const next = argv[i + 1]; if (next !== undefined && !next.startsWith("-")) { args.tuneSpec = next; i++; } }
    else if (a === "--save") args.save = true;
    else if (a === "--no-build") args.noBuild = true;
    else if (a === "--json") args.json = true;
    else if (a === "--rerank") args.rerank = true;
    else if (a === "--golden") args.golden = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--focus") args.focus = argv[++i];
    else if (a === "--depth") { const v = Number(argv[++i]); if (Number.isFinite(v)) args.depth = v; }
    else if (a === "--rollup") args.rollup = true;
    else if (a === "--max-nodes") { const v = Number(argv[++i]); if (Number.isFinite(v)) args.maxNodes = v; }
    else if (a === "--kind") args.kind = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--conf") args.conf = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--format") args.format = argv[++i];
    else if (a === "--downstream") args.downstream = true;
    else if (a === "--include-ambiguous") args.includeAmbiguous = true;
    else if (a === "--path") args.path = argv[++i];
    else if (a === "--symbol") args.symbol = argv[++i];
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--from-path") args.fromPath = argv[++i];
    else if (a === "--to-path") args.toPath = argv[++i];
    else if (a === "--limit") { const v = Number(argv[++i]); if (Number.isFinite(v)) args.limit = v; }
    else if (a === "--centrality") args.centrality = true;
    else if (a === "--edges") args.edges = true;
    else if (a === "--disambig") args.disambig = true;
    else if (a === "--orphans") args.orphans = true;
    else args._.push(a);
  }
  return args;
}

async function runEval(args) {
  const repo = args.repo || process.cwd();
  const cfg = loadConfig(repo);
  if (args.rerank) cfg.rerank = true;
  const goldenPath = args.golden || path.join(repo, "eval", "golden.json");
  if (!existsSync(goldenPath)) {
    process.stderr.write(`eval: no golden file at ${goldenPath} — pass --golden <file>\n`);
    return 2;
  }
  let golden;
  try { golden = JSON.parse(readFileSync(goldenPath, "utf8")); }
  catch (e) { process.stderr.write(`eval: cannot parse ${goldenPath}: ${e.message}\n`); return 2; }
  if (!Array.isArray(golden) || golden.length === 0) {
    process.stderr.write("eval: golden set is empty\n"); return 2;
  }

  const store = await openStore(cfg);
  const hasIndex = !!(await store.chunksTable());
  if (!args.noBuild) {
    await buildIndex(cfg, { rebuild: false });
  } else if (!hasIndex) {
    process.stderr.write(`eval: no index at ${cfg.indexDir} — run: gtir index\n`); return 2;
  }

  const maxK = Math.max(1, Math.min(50, (args.k | 0) || 10));

  // --tune: sweep fusion weights over the golden set and report the grid (no baseline write).
  // Fusion is a query-time step, so the index built above serves every combo; we only re-run
  // search()+scoring per combo. Returns its own exit code.
  if (args.tune) return runTune({ cfg, golden, maxK, spec: args.tuneSpec });

  const searchFn = (q, k) => search(q, cfg, { k });
  const metrics = await evalGolden(golden, searchFn, { maxK });
  metrics.model = (await store.readMeta()).model || cfg.model;

  // Guard the common footgun: running `gtir eval` over the wrong root (e.g. the gtir repo
  // itself instead of its eval/corpus) indexes files whose paths never match the golden set,
  // so every query misses and the metrics are a silent wall of zeros. Say so, actionably.
  const looseK = Math.max(...Object.keys(metrics.recall).map(Number));
  if (metrics.n > 0 && (metrics.recall[looseK] ?? 0) === 0) {
    process.stderr.write(`eval: WARNING all ${metrics.n} queries missed at recall@${looseK} — the index root `
      + `(${cfg.indexDir}) likely doesn't contain the golden paths. To evaluate the bundled corpus run `
      + `\`npm run eval\` (i.e. --repo eval/corpus --golden eval/golden.json).\n`);
  }

  const baselinePath = args.baseline || path.join(repo, "eval", "baseline.json");

  if (args.save) {
    writeFileSync(baselinePath, JSON.stringify(metrics, null, 2) + "\n");
    process.stderr.write(`eval: saved baseline → ${baselinePath} (n=${metrics.n}, model=${metrics.model})\n`);
    if (args.json) process.stdout.write(JSON.stringify(metrics) + "\n");
    return 0;
  }

  let baseline = null;
  if (existsSync(baselinePath)) {
    try { baseline = JSON.parse(readFileSync(baselinePath, "utf8")); } catch { /* treat as none */ }
  }
  printMetricsTable(metrics, baseline);
  if (args.json) process.stdout.write(JSON.stringify(metrics) + "\n");

  if (!baseline) {
    process.stderr.write("eval: no baseline to compare (run with --save to set one)\n");
    return 0;
  }
  if (baseline.model && baseline.model !== metrics.model) {
    process.stderr.write(`eval: WARNING baseline model (${baseline.model}) != current (${metrics.model}) — cross-model comparison\n`);
  }
  // The CLI gates on the stable tiers only: overall + the `gate` tier. Measured on
  // an unchanged index, those are stable run-to-run (recall@k identical; mrr wobbles
  // ~0.004, well under tol). The `hard` tier is the improvement *meter*, not a gate:
  // it's small enough that one borderline query flipping rank 1↔2 between runs moves
  // its recall by ~1/30 ≈ 0.033, so gating on it would flake. It's reported with
  // deltas (see printMetricsTable) so you can read a real gain; it just doesn't fail
  // CI. tol=0.02 absorbs the mrr wobble; real regressions move metrics by ≥0.05.
  const GATING_TIERS = new Set(["gate"]);
  const regressions = [
    ...compareBaseline(metrics, baseline, 0.02),
    ...compareTiers(metrics, baseline, 0.02).filter((r) => GATING_TIERS.has(r.metric.split(":")[0])),
  ];
  if (regressions.length) {
    for (const r of regressions) {
      process.stderr.write(`eval: REGRESSION ${r.metric}: ${r.base} → ${r.cur} (${r.delta})\n`);
    }
    return 1;
  }
  process.stderr.write("eval: no regressions\n");
  return 0;
}

// `gtir eval --edges`: score extracted call edges against a per-edge-correctness golden over the
// indexed corpus. Mirrors runEval's --save/baseline/gate flow but on the edge layer. Returns an exit code.
export async function runEdgeEval({ repo, golden: goldenArg = null, baseline: baselineArg = null, noBuild = false, save = false, json = false } = {}) {
  const root = repo || process.cwd();
  const cfg = loadConfig(root);
  const goldenPath = goldenArg || path.join(root, "eval", "edges-golden.json");
  if (!existsSync(goldenPath)) {
    process.stderr.write(`eval --edges: no golden file at ${goldenPath} — pass --golden <file>\n`);
    return 2;
  }
  let golden;
  try { golden = JSON.parse(readFileSync(goldenPath, "utf8")); }
  catch (e) { process.stderr.write(`eval --edges: cannot parse ${goldenPath}: ${e.message}\n`); return 2; }
  if (!Array.isArray(golden) || golden.length === 0) {
    process.stderr.write("eval --edges: golden set is empty\n"); return 2;
  }

  if (!noBuild) await buildIndex(cfg, { rebuild: false });

  const store = await openStore(cfg);
  const edges = await store.loadEdges();
  if (edges.length === 0) {
    process.stderr.write(`eval --edges: WARNING no edges in index at ${cfg.indexDir} — run \`gtir index\` (or drop --no-build)\n`);
  }
  const metrics = evalEdgeExtraction(edges, golden);
  metrics.model = ((await store.readMeta()) || {}).model || cfg.model;

  printEdgeEval(metrics);
  if (json) process.stdout.write(JSON.stringify(metrics) + "\n");

  const baselinePath = baselineArg || path.join(root, "eval", "edges-baseline.json");
  if (save) {
    writeFileSync(baselinePath, JSON.stringify(metrics, null, 2) + "\n");
    process.stderr.write(`eval --edges: saved baseline → ${baselinePath} (n=${metrics.n}, model=${metrics.model})\n`);
    return 0;
  }

  let base = null;
  if (existsSync(baselinePath)) {
    try { base = JSON.parse(readFileSync(baselinePath, "utf8")); } catch { /* treat as none */ }
  }
  if (!base) {
    process.stderr.write("eval --edges: no baseline to compare (run with --save to set one)\n");
    return 0;
  }
  if (base.model && base.model !== metrics.model) {
    process.stderr.write(`eval --edges: WARNING baseline model (${base.model}) != current (${metrics.model}) — cross-model comparison\n`);
  }
  if (typeof base.recall !== "number" || typeof base.wrong_rate !== "number") {
    process.stderr.write("eval --edges: baseline missing numeric recall/wrong_rate — re-save it with --save; skipping gate\n");
    return 0;
  }
  // Gate: recall must not drop and wrong_rate must not rise beyond tol. tol=0.02 absorbs the small
  // run-to-run wobble in `inferred` promotions (embedding-driven); real regressions move these by ≥0.05.
  const tol = 0.02;
  const regressions = [];
  if (metrics.recall < base.recall - tol) regressions.push(`recall ${base.recall} → ${metrics.recall}`);
  if (metrics.wrong_rate > base.wrong_rate + tol) regressions.push(`wrong_rate ${base.wrong_rate} → ${metrics.wrong_rate}`);
  if (regressions.length) {
    for (const r of regressions) process.stderr.write(`eval --edges: REGRESSION ${r}\n`);
    return 1;
  }
  process.stderr.write("eval --edges: no regressions\n");
  return 0;
}

function printEdgeEval(m) {
  const out = [`edge eval: n=${m.n} recall=${m.recall} wrong=${m.wrong_rate} missing=${m.missing_rate} model=${m.model ?? "?"}`];
  out.push("  by lang:");
  for (const lang of Object.keys(m.byLang).sort()) {
    const b = m.byLang[lang];
    out.push(`    ${lang.padEnd(5)} n=${b.n} correct=${b.correct} wrong=${b.wrong} missing=${b.missing}`);
  }
  out.push(`  conf split: resolved=${m.split.resolved} inferred=${m.split.inferred} dispatch=${m.split.dispatch ?? 0} ambiguous=${m.split.ambiguous} external=${m.split.external}`);
  process.stderr.write(out.join("\n") + "\n");
}

// `gtir eval --orphans`: score orphans classification against a per-symbol-bucket golden over the
// indexed corpus. Mirrors runEdgeEval's build/save/baseline/gate flow. Returns an exit code.
export async function runOrphansEval({ repo, golden: goldenArg = null, baseline: baselineArg = null, noBuild = false, save = false, json = false } = {}) {
  const root = repo || process.cwd();
  const cfg = loadConfig(root);
  const goldenPath = goldenArg || path.join(root, "eval", "orphans-golden.json");
  if (!existsSync(goldenPath)) {
    process.stderr.write(`eval --orphans: no golden file at ${goldenPath} — pass --golden <file>\n`); return 2;
  }
  let golden;
  try { golden = JSON.parse(readFileSync(goldenPath, "utf8")); }
  catch (e) { process.stderr.write(`eval --orphans: cannot parse ${goldenPath}: ${e.message}\n`); return 2; }
  if (!Array.isArray(golden) || golden.length === 0) {
    process.stderr.write("eval --orphans: golden set is empty\n"); return 2;
  }

  if (!noBuild) await buildIndex(cfg, { rebuild: false });

  const result = await orphansQuery(cfg);
  if (result.error) { process.stderr.write(`eval --orphans: ${result.error}\n`); return 2; }
  const metrics = evalOrphans(result, golden);
  const store = await openStore(cfg);
  metrics.model = ((await store.readMeta()) || {}).model || cfg.model;

  printOrphansEval(metrics);
  if (json) process.stdout.write(JSON.stringify(metrics) + "\n");

  const baselinePath = baselineArg || path.join(root, "eval", "orphans-baseline.json");
  if (save) {
    writeFileSync(baselinePath, JSON.stringify(metrics, null, 2) + "\n");
    process.stderr.write(`eval --orphans: saved baseline → ${baselinePath} (n=${metrics.n}, model=${metrics.model})\n`);
    return 0;
  }
  let base = null;
  if (existsSync(baselinePath)) { try { base = JSON.parse(readFileSync(baselinePath, "utf8")); } catch { /* ignore */ } }
  if (!base) { process.stderr.write("eval --orphans: no baseline to compare (run with --save to set one)\n"); return 0; }
  if (base.model && base.model !== metrics.model) {
    process.stderr.write(`eval --orphans: WARNING baseline model (${base.model}) != current (${metrics.model}) — cross-model comparison\n`);
  }
  if (typeof base.accuracy !== "number" || typeof base.false_dead !== "number") {
    process.stderr.write("eval --orphans: baseline missing numeric accuracy/false_dead — re-save it with --save; skipping gate\n"); return 0;
  }
  const tol = 0.005;
  const regressions = [];
  if (metrics.accuracy < base.accuracy - tol) regressions.push(`accuracy ${base.accuracy} → ${metrics.accuracy}`);
  if (metrics.false_dead > base.false_dead) regressions.push(`false_dead ${base.false_dead} → ${metrics.false_dead}`);
  if (regressions.length) { for (const r of regressions) process.stderr.write(`eval --orphans: REGRESSION ${r}\n`); return 1; }
  process.stderr.write("eval --orphans: no regressions\n");
  return 0;
}

function printOrphansEval(m) {
  process.stderr.write(
    `orphans eval: n=${m.n} accuracy=${m.accuracy} correct=${m.correct} false_dead=${m.false_dead} `
    + `false_entrypoint=${m.false_entrypoint} missing=${m.missing} model=${m.model ?? "?"}\n`);
}

// Read the disambiguator's inputs from a store built with cfg.disambiguate=false (raw ambiguous
// edges persisted). Mirrors indexEdges' input-building (symbolIndex/callSiteVec from chunks,
// importMap from import edges) but read-only over the full stored set.
async function gatherDisambigInputs(store) {
  const symbolIndex = new Map(), callSiteVec = new Map();
  const tbl = await store.chunksTable();
  if (tbl) {
    const rows = await tbl.query().select(["path", "line_start", "line_end", "text", "embedding", "content_hash"]).toArray();
    for (const r of rows) {
      if (r.content_hash && r.embedding) callSiteVec.set(r.content_hash, Array.from(r.embedding));
      for (const name of declaredSymbols(r.text)) {
        if (!symbolIndex.has(name)) symbolIndex.set(name, []);
        symbolIndex.get(name).push({ path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end),
          embedding: r.embedding ? Array.from(r.embedding) : null, content_hash: r.content_hash || null });
      }
    }
  }
  const edges = await store.loadEdges();
  const importMap = new Map();
  for (const e of edges) {
    if (e.kind === "imports" && e.to_path) {
      let s = importMap.get(e.from_path);
      if (!s) { s = new Set(); importMap.set(e.from_path, s); }
      s.add(e.to_path);
    }
  }
  const ambiguousRows = edges.filter((e) => e.kind === "calls" && e.conf === "ambiguous");
  return { symbolIndex, callSiteVec, importMap, ambiguousRows };
}

// `gtir eval --disambig`: score the ambiguous→inferred promotion against a precision-first golden.
// Builds the corpus index with disambiguation OFF so raw ambiguous rows persist, then replays the
// real disambiguateEdges and scores. --tune sweeps threshold × margin. Returns an exit code.
export async function runDisambigEval({ repo, golden: goldenArg = null, baseline: baselineArg = null, noBuild = false, save = false, json = false, tune = false, tuneSpec = null } = {}) {
  const root = repo || process.cwd();
  const cfg = loadConfig(root);
  cfg.disambiguate = false; // persist RAW ambiguous edges (full candidate sets) for the replay
  if (!repo && !noBuild) {
    process.stderr.write("eval --disambig: WARNING no --repo given — building the current directory with "
      + "disambiguation OFF (downgrades stored inferred edges). Pass --repo <corpus> (or --no-build) to avoid this.\n");
  }
  const goldenPath = goldenArg || path.join(root, "eval", "disambig-golden.json");
  if (!existsSync(goldenPath)) {
    process.stderr.write(`eval --disambig: no golden file at ${goldenPath} — pass --golden <file>\n`);
    return 2;
  }
  let golden;
  try { golden = JSON.parse(readFileSync(goldenPath, "utf8")); }
  catch (e) { process.stderr.write(`eval --disambig: cannot parse ${goldenPath}: ${e.message}\n`); return 2; }
  if (!Array.isArray(golden) || golden.length === 0) {
    process.stderr.write("eval --disambig: golden set is empty\n"); return 2;
  }

  if (!noBuild) await buildIndex(cfg, { rebuild: false });

  const store = await openStore(cfg);
  const inputs = await gatherDisambigInputs(store);
  if (tune) return runDisambigTune({ cfg, golden, inputs, spec: tuneSpec });

  if (inputs.ambiguousRows.length === 0) {
    process.stderr.write(`eval --disambig: WARNING no ambiguous edges in index at ${cfg.indexDir} — the corpus produced nothing to disambiguate\n`);
  }
  const replayed = disambiguateEdges(inputs.ambiguousRows, {
    symbolIndex: inputs.symbolIndex, callSiteVec: inputs.callSiteVec, importMap: inputs.importMap,
    threshold: cfg.disambigThreshold, margin: cfg.disambigMargin,
  });
  const metrics = evalDisambiguation(replayed, golden);
  metrics.model = ((await store.readMeta()) || {}).model || cfg.model;

  printDisambigEval(metrics);
  if (json) process.stdout.write(JSON.stringify(metrics) + "\n");

  const baselinePath = baselineArg || path.join(root, "eval", "disambig-baseline.json");
  if (save) {
    writeFileSync(baselinePath, JSON.stringify(metrics, null, 2) + "\n");
    process.stderr.write(`eval --disambig: saved baseline → ${baselinePath} (n=${metrics.n}, model=${metrics.model})\n`);
    return 0;
  }

  let base = null;
  if (existsSync(baselinePath)) {
    try { base = JSON.parse(readFileSync(baselinePath, "utf8")); } catch { /* treat as none */ }
  }
  if (!base) {
    process.stderr.write("eval --disambig: no baseline to compare (run with --save to set one)\n");
    return 0;
  }
  if (base.model && base.model !== metrics.model) {
    process.stderr.write(`eval --disambig: WARNING baseline model (${base.model}) != current (${metrics.model}) — cross-model comparison\n`);
  }
  if (typeof base.precision !== "number") {
    process.stderr.write("eval --disambig: baseline missing numeric precision — re-save it with --save; skipping gate\n");
    return 0;
  }
  // Gate on PRECISION only (precision-first by design): mis-promotion is the costly error. recall and
  // abstain_rate are reported meters, deliberately not gated — recall on a small golden flakes, and a
  // legitimately conservative model can sit at 0 promotions (precision vacuously 1.0). Use --tune to
  // explore the recall/precision tradeoff.
  const tol = 0.02;
  if (metrics.precision < base.precision - tol) {
    process.stderr.write(`eval --disambig: REGRESSION precision ${base.precision} → ${metrics.precision}\n`);
    return 1;
  }
  process.stderr.write("eval --disambig: no regressions\n");
  return 0;
}

function printDisambigEval(m) {
  const c = m.cells;
  process.stderr.write(
    `disambig eval: n=${m.n} precision=${m.precision} recall=${m.recall} abstain=${m.abstain_rate} promotions=${m.promotions} model=${m.model}\n`
    + `  confusion: tp=${c.tp} fp=${c.fp} fn=${c.fn} tn=${c.tn}\n`);
}

// `gtir eval --disambig --tune [spec]`: replay disambiguateEdges over a threshold × margin grid
// against the already-gathered inputs (one embed pass, many combos — like fusion --tune), score
// precision/recall per cell, and recommend the precision-first operating point.
function runDisambigTune({ cfg, golden, inputs, spec } = {}) {
  // Default grid centered on the config defaults (threshold 0.55, margin 0.05).
  const axes = spec ? parseGridSpec(spec) : { disambigThreshold: [0.45, 0.5, 0.55, 0.6, 0.65], disambigMargin: [0.03, 0.05, 0.08] };
  const combos = gridCombos(axes);
  const rows = combos.map((w) => {
    const replayed = disambiguateEdges(inputs.ambiguousRows, {
      symbolIndex: inputs.symbolIndex, callSiteVec: inputs.callSiteVec, importMap: inputs.importMap,
      threshold: w.disambigThreshold ?? cfg.disambigThreshold, margin: w.disambigMargin ?? cfg.disambigMargin,
    });
    const m = evalDisambiguation(replayed, golden);
    return { threshold: w.disambigThreshold ?? cfg.disambigThreshold, margin: w.disambigMargin ?? cfg.disambigMargin,
      precision: m.precision, recall: m.recall, promotions: m.promotions };
  });
  const ranked = rankDisambigOperatingPoint(rows);
  const best = ranked[0];
  const cur = (t, mg) => t === cfg.disambigThreshold && mg === cfg.disambigMargin;
  const cell = (s) => String(s).padStart(8);
  const out = [`eval --disambig --tune: ${combos.length} combo(s), n=${golden.length}`,
    `  ${"thr".padStart(6)}${"margin".padStart(8)}${"prec".padStart(8)}${"recall".padStart(8)}${"promo".padStart(8)}`];
  for (const r of rows) {
    const mark = (r === best) ? "→" : (cur(r.threshold, r.margin) ? "*" : " ");
    out.push(`${mark} ${String(r.threshold).padStart(6)}${cell(r.margin)}${cell(r.precision)}${cell(r.recall)}${cell(r.promotions)}`);
  }
  out.push("  legend: → best (precision-first: max recall at precision 1)   * current config");
  out.push(`  → set in .gtir/config.json: "disambigThreshold": ${best.threshold}, "disambigMargin": ${best.margin}`);
  process.stderr.write(out.join("\n") + "\n");
  return 0;
}

// Memoizing embed wrapper: the golden query set is fixed across combos, so embed each unique
// text once and replay from cache. Turns an N-combo sweep from N×(embed all queries) into
// 1×(embed all queries) — the embed call is the only real cost; fusion is in-memory.
function memoEmbed(cfg) {
  const cache = new Map();
  const real = (texts) => embedTexts(texts, cfg);
  return async (texts) => {
    const out = new Array(texts.length);
    const miss = [], missIdx = [];
    texts.forEach((t, i) => { if (cache.has(t)) out[i] = cache.get(t); else { miss.push(t); missIdx.push(i); } });
    if (miss.length) {
      const got = await real(miss);
      got.forEach((v, j) => { cache.set(miss[j], v); out[missIdx[j]] = v; });
    }
    return out;
  };
}

// `gtir eval --tune [spec]`: sweep RRF fusion weights over the golden set and print the grid,
// best-first, so the per-bucket weights (ftsWeight / ftsWeightMixed / ftsWeightSymbol) become
// data-driven instead of hand-set. Default grid sweeps the pure-NL ftsWeight (the one bucket
// never swept); pass a spec like "ftsWeight=0,0.2;ftsWeightMixed=0,0.3" to sweep others.
async function runTune({ cfg, golden, maxK, spec }) {
  const axes = spec ? parseGridSpec(spec) : { ftsWeight: [0, 0.1, 0.2, 0.3, 0.5] };
  const combos = gridCombos(axes);
  const embedImpl = memoEmbed(cfg);                       // shared cache across every combo
  const searchFnFor = (w) => (q, k) => search(q, { ...cfg, ...w, embedImpl }, { k });
  const sweptKeys = Object.keys(axes);
  const curWeights = Object.fromEntries(sweptKeys.map((k) => [k, cfg[k]]));

  process.stderr.write(`eval --tune: ${combos.length} combo(s) over {${sweptKeys.join(", ")}}, n=${golden.length} queries\n`);
  const rows = await sweepWeights(golden, combos, searchFnFor, evalGolden, {
    maxK,
    onProgress: (i, n, w) => process.stderr.write(`  [${i + 1}/${n}] ${weightsKey(w)} ...\n`),
  });

  const ranked = rankSweep(rows, defaultObjective);
  const KNOWN_TIERS = ["gate", "hard", "symbol", "mixed"];   // preferred display order; unknown tiers appended
  const tiers = [...new Set(golden.map((g) => g.tier || "gate"))];
  const tierOrder = KNOWN_TIERS.filter((t) => tiers.includes(t))
    .concat(tiers.filter((t) => !KNOWN_TIERS.includes(t)));

  // A combo carries every swept axis (gridCombos fills them all), so "is this the current config?"
  // is a plain per-axis equality against cfg.
  const isCurrent = (w) => sweptKeys.every((k) => w[k] === cfg[k]);
  const cell = (s) => String(s).padStart(7);
  const fmt = (x) => cell(x == null ? "n/a" : x.toFixed(3));
  const cols = ["mrr", "R@1", "R@5", ...tierOrder.map((t) => `${t.slice(0, 4)}@1`)];
  const out = [`  ${"combo".padEnd(32)}${cols.map(cell).join("")}`];
  for (const r of ranked) {
    const m = r.metrics, bt = m.byTier || {};
    const mark = isCurrent(r.weights) ? "*" : (r === ranked[0] ? "→" : " ");
    const vals = [m.mrr, m.recall?.[1], m.recall?.[5], ...tierOrder.map((t) => bt[t]?.recall?.[1])];
    out.push(`${mark} ${weightsKey(r.weights).padEnd(32)}${vals.map(fmt).join("")}`);
  }
  process.stderr.write(out.join("\n") + "\n");
  process.stderr.write("  legend: → best by objective (mrr, then R@1, R@5)   * current config\n");

  const best = ranked[0];
  const cur = rows.find((r) => isCurrent(r.weights));
  const recLine = `  → set in .gtir/config.json: ${sweptKeys.map((k) => `"${k}": ${best.weights[k]}`).join(", ")}\n`;
  if (!cur) {
    // Current config falls outside the swept grid (e.g. a range that skips the live value), so there's
    // no in-grid row to diff against — just point at the grid winner.
    process.stderr.write(`eval --tune: current ${weightsKey(curWeights)} is outside the swept grid; grid best is ${weightsKey(best.weights)}.\n${recLine}`);
  } else if (best === cur) {
    process.stderr.write("eval --tune: current weights are already the grid best.\n");
  } else {
    const dM = best.metrics.mrr - cur.metrics.mrr;
    const dR = (best.metrics.recall?.[1] ?? 0) - (cur.metrics.recall?.[1] ?? 0);
    const gateCur = cur.metrics.byTier?.gate?.recall?.[1];
    const gateBest = best.metrics.byTier?.gate?.recall?.[1];
    const gateNote = (gateCur != null && gateBest != null && gateBest < gateCur - 0.005)
      ? `  ⚠ gate R@1 regresses ${gateCur.toFixed(3)}→${gateBest.toFixed(3)} (gate is the CI gating tier)` : "";
    const sign = (d) => (d >= 0 ? "+" : "") + d.toFixed(4);
    process.stderr.write(
      `eval --tune: best ${weightsKey(best.weights)} vs current ${weightsKey(cur.weights)}: `
      + `mrr ${sign(dM)}, R@1 ${sign(dR)}.${gateNote}\n`
      + (Math.abs(dM) <= 0.005 && Math.abs(dR) <= 0.005
        ? "  → within noise; keep current weights.\n" : recLine));
  }
  return 0;
}

function printMetricsTable(m, base) {
  const fb = base ? flattenMetrics(base) : {};
  const line = (label, val, baseFlat = fb) => {
    if (val === null || val === undefined) return `  ${label.padEnd(11)} n/a`;
    const b = baseFlat[label];
    if (b === undefined) return `  ${label.padEnd(11)} ${val.toFixed(4)}`;
    const d = val - b;
    const ds = Math.abs(d) <= 0.005 ? "~0" : (d > 0 ? "+" : "") + d.toFixed(4);
    return `  ${label.padEnd(11)} ${val.toFixed(4)}  (base ${b.toFixed(4)}, ${ds})`;
  };
  const out = [`eval: n=${m.n} n_sec=${m.n_sec} model=${m.model}`];
  for (const k of Object.keys(m.recall)) out.push(line(`recall@${k}`, m.recall[k]));
  out.push(line("mrr", m.mrr));
  for (const k of Object.keys(m.sec_hit)) out.push(line(`sec_hit@${k}`, m.sec_hit[k]));
  for (const tier of Object.keys(m.byTier || {})) {
    const tm = m.byTier[tier];
    const tb = base && base.byTier && base.byTier[tier] ? flattenMetrics(base.byTier[tier]) : {};
    out.push(`  [${tier}] n=${tm.n} n_sec=${tm.n_sec}`);
    out.push(line("recall@1", tm.recall[1], tb));
    out.push(line("recall@5", tm.recall[5], tb));
    out.push(line("mrr", tm.mrr, tb));
    if (tm.sec_hit[1] !== null && tm.sec_hit[1] !== undefined) out.push(line("sec_hit@1", tm.sec_hit[1], tb));
  }
  process.stderr.write(out.join("\n") + "\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const repo = args.repo || process.cwd();

  try {
    switch (cmd) {
      case "index": {
        const r = await runIndex({ repo, rebuild: !!args.rebuild, noCache: args.noCache ?? false, preflight: true });
        // Keep the regenerable index out of version control — the binary LanceDB store must never be
        // committed. `init` does this; do it on a plain `index` too (git repos only) so users who skip
        // init don't accidentally `git add` a huge .gtir/ index.
        const cfg0 = loadConfig(repo);
        if (existsSync(path.join(cfg0.repo, ".git")) && ensureGitignore(cfg0.repo).added) {
          process.stderr.write("gtir: added .gtir/ to .gitignore (the index is regenerable; don't commit it)\n");
        }
        process.stderr.write(`gtir: indexed ${r.chunks} chunks (${r.reused ?? 0} reused, ${r.embedded ?? 0} embedded, ${r.skipped} skipped, ${r.evicted} evicted), dim=${r.dim}\n`);
        for (const w of r.warnings ?? []) process.stderr.write(`gtir: note: ${w}\n`);
        break;
      }
      case "refresh": {
        // Hook-driven refresh stands down in two cases:
        //  - a git op is mid-flight (rebase/cherry-pick/merge): post-rewrite refreshes once it ends.
        //  - a live watcher is already keeping this repo fresh: don't pay a redundant commit-time pass.
        if (args.hook) {
          if (gitBusy(repo)) { process.stderr.write("gtir: git operation in progress — refresh deferred\n"); break; }
          if (watcherLive(loadConfig(repo))) { process.stderr.write("gtir: a live watcher is refreshing this repo — skipping the commit-hook pass\n"); break; }
        }
        const r = await runIndex({ repo, rebuild: false, noCache: args.noCache ?? false });
        process.stderr.write(`gtir: refresh — ${r.chunks} chunks updated (${r.reused ?? 0} reused, ${r.embedded ?? 0} embedded, ${r.skipped} skipped, ${r.evicted} evicted)\n`);
        for (const w of r.warnings ?? []) process.stderr.write(`gtir: note: ${w}\n`);
        break;
      }
      case "search": {
        const query = args._.join(" ");
        const hits = await runSearch({ repo, query, k: args.k || 8, pathPrefix: args.pathPrefix, language: args.language, rerank: args.rerank, centrality: !!args.centrality, edges: !!args.edges });
        process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
        break;
      }
      case "status": {
        process.stdout.write(JSON.stringify(await runStatus({ repo }), null, 2) + "\n");
        break;
      }
      case "demo": {
        const query = args.query ?? (args._.length ? args._.join(" ") : null);
        const color = !args.noColor && !process.env.NO_COLOR && !!process.stdout.isTTY;
        const r = await runDemo({ repo: args.repo ?? null, query, grepTerm: args.grepTerm, log: (m) => process.stderr.write(`gtir: ${m}\n`) });
        process.stdout.write(formatDemo(r, { color }));
        break;
      }
      case "setup": {
        const r = await runSetup({ repo });
        process.stderr.write(`gtir: Ollama OK — model=${r.model} dim=${r.dim}\n`);
        break;
      }
      case "doctor": {
        const cfg = loadConfig(repo);
        const r = await runDoctor(cfg, { pull: !args.noPull, log: (m) => process.stderr.write(`gtir: ${m}\n`) });
        process.stderr.write(`gtir doctor — ${r.ready ? "ready ✓" : "NOT ready ✗"}\n${r.report}\n`);
        process.exitCode = r.ready ? 0 : 1;  // set, don't process.exit() — let fetch sockets close (avoids a libuv exit assert on Windows)
        break;
      }
      case "hook": {
        if (args.remove) { removeHook(repo); process.stderr.write("gtir: hooks removed\n"); }
        else { installHook(repo); process.stderr.write("gtir: auto-refresh hooks installed (post-commit + post-rewrite; rebase-aware)\n"); }
        break;
      }
      case "install": {
        runInstall({ repo, uninstall: !!args.uninstall });
        break;
      }
      case "hooknudge": {
        // PreToolUse hook command: read all of stdin, emit an additionalContext nudge for
        // Grep/Glob (else nothing). Must never throw (malformed/empty stdin → silent exit 0).
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => { input += c; });
        process.stdin.on("end", () => {
          try { const out = hooknudge(input); if (out) process.stdout.write(out); } catch { /* exit 0 silently */ }
          process.exit(0);
        });
        process.stdin.on("error", () => process.exit(0));
        return; // keep the process alive until stdin closes; do not fall through to exit
      }
      case "watch": {
        const cfg = loadConfig(repo);
        const debounceMs = args.debounce ?? 1500;
        const sweepMs = args.sweep != null ? args.sweep * 1000 : undefined; // --sweep is seconds (0 disables)
        // Long-lived, like `mcp`: chokidar (persistent) holds the event loop open. Each settled
        // batch runs an incremental refresh; it defers while a git op is in flight (gitBusy).
        const handle = watchRepo(cfg, { debounceMs, sweepMs, log: (m) => process.stderr.write(`gtir: ${m}\n`) });
        process.on("SIGINT", () => { handle.close().finally(() => process.exit(0)); }); // drop the liveness lock on Ctrl+C
        process.stderr.write(`gtir: watching ${cfg.repo} for changes (debounce ${debounceMs}ms) — Ctrl+C to stop\n`);
        return; // keep the process alive on the watcher; do not fall through to exit
      }
      case "fetch-grammars": {
        const installed = await fetchGrammars({ log: (m) => process.stderr.write(m + "\n") });
        process.stderr.write(`gtir: ${installed.length} grammar${installed.length === 1 ? "" : "s"} ready — re-run \`gtir index --rebuild\` to chunk those files via AST.\n`);
        break;
      }
      case "mcp": {
        const repos = args.repos ?? (args.repo ? [args.repo] : []);
        if (repos.length === 0) { process.stderr.write("gtir mcp: pass at least one --repo <path>\n"); process.exit(2); }
        if (args.printConfig) { process.stdout.write(printConfig(repos, { watch: !!args.watch, debounceMs: args.debounce ?? null }) + "\n"); break; }
        const indexes = resolveIndexes(repos, args.labels ?? {});
        const served = await preflightIndexes(indexes, { log: (m) => process.stderr.write(`gtir mcp: ${m}\n`) });
        if (served.length === 0) { process.stderr.write("gtir mcp: no ready indexes — run: gtir doctor\n"); process.exit(1); }
        if (args.watch) {
          // Live-refresh each served index as files change (uncommitted edits). Logs to STDERR
          // only — stdout is the JSON-RPC channel. Defers during git ops via the shared gitBusy gate.
          const debounceMs = args.debounce ?? 1500;
          const sweepMs = args.sweep != null ? args.sweep * 1000 : undefined; // --sweep is seconds (0 disables)
          const handles = startWatchers(served, { debounceMs, sweepMs, log: (m) => process.stderr.write(`gtir mcp: watch ${m}\n`) });
          process.on("SIGINT", () => { Promise.all(handles.map((h) => h.close())).finally(() => process.exit(0)); }); // drop liveness locks on Ctrl+C
          process.stderr.write(`gtir mcp: live-refresh ON (debounce ${debounceMs}ms) — watching [${served.map((i) => i.label).join(", ")}]\n`);
        }
        serveStdio(served, { version: pkgVersion() });
        return; // keep the process alive on stdin; do not fall through to exit
      }
      case "eval": {
        if (args.disambig) process.exit(await runDisambigEval(args));
        if (args.orphans) process.exit(await runOrphansEval({ repo: args.repo, golden: args.golden, baseline: args.baseline, noBuild: args.noBuild, save: args.save, json: args.json }));
        process.exit(await (args.edges ? runEdgeEval(args) : runEval(args)));
      }
      case "callstats": {
        process.exit(await runCallstats({ repo, json: args.json, lang: args.lang ?? null }));
      }
      case "init": {
        const mode = args.notes ? "notes" : args.code ? "code" : null;
        const r = await runInit({ repo, mode, index: !args.noIndex, hook: !args.noHook });
        process.stderr.write(`gtir init: ${r.repo}\n`);
        process.stderr.write(`  mode: ${r.mode}${mode ? " (forced)" : " (detected)"}\n`);
        process.stderr.write(`  config: ${r.config.written ? "wrote .gtir/config.json" : `kept existing (${r.config.reason})`}\n`);
        process.stderr.write(`  gitignore: ${r.gitignore.added ? ".gtir/ added" : "already ignored"}\n`);
        if (args.noIndex) process.stderr.write("  index: skipped (--no-index)\n");
        else process.stderr.write(`  index: ${r.indexed.chunks} chunks, dim=${r.indexed.dim}\n`);
        if (args.noHook) process.stderr.write("  hook: skipped (--no-hook)\n");
        else if (r.hookInstalled) process.stderr.write("  hook: auto-refresh installed (post-commit + post-rewrite; rebase-aware)\n");
        else if (r.lefthookSnippet) process.stderr.write(`  hook: lefthook detected — add to lefthook.yml:\n\n${r.lefthookSnippet}\n\n`);
        else if (r.hookManager === "husky") process.stderr.write("  hook: husky detected — add 'gtir refresh --repo .' to .husky/post-commit\n");
        else process.stderr.write("  hook: no git repo — auto-refresh skipped (run 'gtir refresh' manually)\n");
        break;
      }
      case "graph": {
        const r = await runGraph({
          repo, out: args.out ?? null, format: args.format ?? "html",
          focus: args.focus ?? null, depth: args.depth ?? 2,
          rollup: !!args.rollup, maxNodes: args.maxNodes ?? Infinity,
          kind: args.kind ?? null, conf: args.conf ?? null, pathPrefix: args.pathPrefix ?? null,
        });
        process.stderr.write(`gtir: wrote ${r.out} (${r.nodes} nodes, ${r.edges} edges)\n`);
        if (r.truncated) process.stderr.write(`gtir: graph truncated by --max-nodes — dropped ${r.dropped} lowest-degree node(s); raise or drop --max-nodes, or narrow with --focus/--path-prefix\n`);
        break;
      }
      case "impact": {
        const symbol = args.symbol ?? (args._.length ? args._.join(" ") : null);
        const r = await runImpact({ repo, symbol, path: args.path, downstream: !!args.downstream,
          depth: args.depth, includeAmbiguous: !!args.includeAmbiguous, limit: args.limit });
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        if (r.error || r.ambiguous) process.exitCode = 2;
        break;
      }
      case "orphans": {
        const r = await runOrphans({ repo });
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        if (r.error) process.exitCode = 2;
        break;
      }
      case "cycles": {
        const r = await runCycles({ repo, includeAmbiguous: !!args.includeAmbiguous });
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        if (r.error) process.exitCode = 2;
        break;
      }
      case "path": {
        // positional: `gtir path <from> <to>` OR flag form `--from <sym> --to <sym>`
        const fromSym = args.from ?? args._[0] ?? null;
        const toSym = args.to ?? args._[1] ?? null;
        if (!fromSym || !toSym) {
          process.stderr.write("gtir path: usage: gtir path <from> <to> [--from-path P] [--to-path P] [--depth N] [--include-ambiguous]\n");
          process.exitCode = 2;
          break;
        }
        const r = await runPath({ repo, from: fromSym, to: toSym,
          fromPath: args.fromPath ?? null, toPath: args.toPath ?? null,
          depth: args.depth, includeAmbiguous: !!args.includeAmbiguous });
        if (r.error) {
          process.stderr.write(`gtir path: ${r.error}\n`);
          process.exitCode = 0; // not a crash, just not found
          break;
        }
        if (r.path === null) {
          process.stderr.write(`gtir path: no path found from '${fromSym}' to '${toSym}'\n`);
        } else {
          // Format: symbol · file → symbol · file → …
          const labels = r.path.map((key) => {
            const h = key.indexOf("#");
            if (h >= 0) return `${key.slice(h + 1)} · ${key.slice(0, h)}`;
            return key;
          });
          process.stdout.write(labels.join(" → ") + "\n");
        }
        break;
      }
      default:
        process.stderr.write([
          "usage: gtir <command> [options]",
          "  gtir init    --repo <project> [--notes|--code] [--no-index] [--no-hook]",
          "  gtir index   --repo <project> [--rebuild] [--no-cache]",
          "  gtir refresh --repo <project> [--no-cache]",
          "  gtir watch   --repo <project> [--debounce 1500] [--sweep 300]   # live-refresh as files change (uncommitted edits)",
          "  gtir search  --repo <project> <query> [-k N] [--path-prefix P] [--language L]",
          "  gtir demo    [--repo <project>] [--query <q>]   # see meaning-match vs grep, on a sample corpus",
          "  gtir status  --repo <project>",
          "  gtir doctor  [--repo <project>] [--no-pull]   # check Ollama, pull the model, verify readiness",
          "  gtir setup   --repo <project>",
          "  gtir hook    --repo <project> [--remove]",
          "  gtir install --repo <project> [--uninstall]   # wire Claude Code (.mcp.json + PreToolUse hook + CLAUDE.md) to prefer gtir's MCP tools",
          "  gtir hooknudge   # PreToolUse hook: reads stdin, nudges agents toward gtir's MCP tools on Grep/Glob (internal)",
          "  gtir fetch-grammars   # download prebuilt shader grammars (HLSL/GLSL, ~5MB, no toolchain)",
          "  gtir mcp     --repo <project> [--label name:<repo>] [--watch [--debounce 1500]] [--print-config]",
          "  gtir eval    --repo <project> [--golden <f>] [-k 10] [--save] [--no-build] [--json]",
          "  gtir eval    --repo <project> --tune [\"ftsWeight=0,0.2;ftsWeightMixed=0,0.3\"]   # sweep fusion weights on the golden set",
          "  gtir eval    --repo <project> --disambig [--tune] [--save] [--no-build]   # score ambiguous→inferred promotion",
          "  gtir graph   --repo <project> [--out FILE] [--format <html|mermaid>] [--focus SYM [--depth 2]] [--rollup] [--max-nodes 400] [--kind calls,imports] [--conf ambiguous] [--path-prefix P]",
          "  gtir callstats --repo <project> [--json] [--lang <id>]   # member-call resolution rate + unresolved-reason breakdown (deterministic, no Ollama at resolve time)",
          "  gtir path    <from> <to> --repo <project> [--from-path P] [--to-path P] [--depth N] [--include-ambiguous]   # shortest call-path between two symbols",
        ].join("\n") + "\n");
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    process.stderr.write(`gtir: error — ${e.message}\n`);
    process.exit(1);
  }
}

// Run main() only when executed directly (not when imported by tests).
// Resolve symlinks on BOTH sides so a globally-linked `gtir` bin (npm link /
// npm i -g, where argv[1] is a symlink) still matches the real module path.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}
if (invokedDirectly()) main();
