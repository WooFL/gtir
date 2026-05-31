#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { search } from "../src/search.mjs";
import { openStore } from "../src/store.mjs";
import { installHook, removeHook } from "../src/hook.mjs";
import { probeDim } from "../src/embed.mjs";
import { runInit } from "../src/init.mjs";
import { resolveIndexes, serveStdio, printConfig } from "../src/mcp.mjs";
import { evalGolden, flattenMetrics, compareBaseline, compareTiers } from "../src/eval.mjs";

// --- programmatic entrypoints (used by tests and the dispatcher) ---

function pkgVersion() {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; }
  catch { return "0.0.0"; }
}

export async function runIndex({ repo, rebuild = false, noCache = false, embedImpl = null } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
  cfg.noCache = noCache ?? cfg.noCache ?? false;
  return buildIndex(cfg, { rebuild });
}

export async function runSearch({ repo, query, k = 8, pathPrefix = null, language = null, embedImpl = null } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
  return search(query, cfg, { k, pathPrefix, language });
}

export async function runStatus({ repo } = {}) {
  const cfg = loadConfig(repo);
  const store = await openStore(cfg);
  const meta = await store.readMeta();
  const man = await store.loadManifest();
  return { repo: cfg.repo, indexDir: cfg.indexDir, files: Object.keys(man).length, ...meta };
}

export async function runSetup({ repo } = {}) {
  const cfg = loadConfig(repo);
  const dim = await probeDim(cfg); // throws a remediation message if Ollama/model missing
  return { model: cfg.model, ollamaUrl: cfg.ollamaUrl, dim };
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
    else if (a === "-k" || a === "--k") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && Number.isFinite(Number(next))) {
        args.k = Number(next); i++;
      }
      // missing/non-numeric value: leave args.k unset; search falls back to default
    }
    else if (a === "--path-prefix") args.pathPrefix = argv[++i];
    else if (a === "--language") args.language = argv[++i];
    else if (a === "--remove") args.remove = true;
    else if (a === "--notes") args.notes = true;
    else if (a === "--code") args.code = true;
    else if (a === "--no-cache") args.noCache = true;
    else if (a === "--no-index") args.noIndex = true;
    else if (a === "--no-hook") args.noHook = true;
    else if (a === "--save") args.save = true;
    else if (a === "--no-build") args.noBuild = true;
    else if (a === "--json") args.json = true;
    else if (a === "--golden") args.golden = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function runEval(args) {
  const repo = args.repo || process.cwd();
  const cfg = loadConfig(repo);
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
  const searchFn = (q, k) => search(q, cfg, { k });
  const metrics = await evalGolden(golden, searchFn, { maxK });
  metrics.model = (await store.readMeta()).model || cfg.model;

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
        const r = await runIndex({ repo, rebuild: !!args.rebuild, noCache: args.noCache ?? false });
        process.stderr.write(`gtir: indexed ${r.chunks} chunks (${r.reused ?? 0} reused, ${r.embedded ?? 0} embedded, ${r.skipped} skipped, ${r.evicted} evicted), dim=${r.dim}\n`);
        break;
      }
      case "refresh": {
        const r = await runIndex({ repo, rebuild: false, noCache: args.noCache ?? false });
        process.stderr.write(`gtir: refresh — ${r.chunks} chunks updated (${r.reused ?? 0} reused, ${r.embedded ?? 0} embedded, ${r.skipped} skipped, ${r.evicted} evicted)\n`);
        break;
      }
      case "search": {
        const query = args._.join(" ");
        const hits = await runSearch({ repo, query, k: args.k || 8, pathPrefix: args.pathPrefix, language: args.language });
        process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
        break;
      }
      case "status": {
        process.stdout.write(JSON.stringify(await runStatus({ repo }), null, 2) + "\n");
        break;
      }
      case "setup": {
        const r = await runSetup({ repo });
        process.stderr.write(`gtir: Ollama OK — model=${r.model} dim=${r.dim}\n`);
        break;
      }
      case "hook": {
        if (args.remove) { removeHook(repo); process.stderr.write("gtir: hook removed\n"); }
        else { installHook(repo); process.stderr.write("gtir: post-commit refresh hook installed\n"); }
        break;
      }
      case "mcp": {
        const repos = args.repos ?? (args.repo ? [args.repo] : []);
        if (repos.length === 0) { process.stderr.write("gtir mcp: pass at least one --repo <path>\n"); process.exit(2); }
        if (args.printConfig) { process.stdout.write(printConfig(repos) + "\n"); break; }
        const indexes = resolveIndexes(repos, args.labels ?? {});
        serveStdio(indexes, { version: pkgVersion() });
        return; // keep the process alive on stdin; do not fall through to exit
      }
      case "eval": {
        process.exit(await runEval(args));
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
        else if (r.hookInstalled) process.stderr.write("  hook: post-commit auto-refresh installed\n");
        else if (r.lefthookSnippet) process.stderr.write(`  hook: lefthook detected — add to lefthook.yml:\n\n${r.lefthookSnippet}\n\n`);
        else if (r.hookManager === "husky") process.stderr.write("  hook: husky detected — add 'gtir refresh --repo .' to .husky/post-commit\n");
        else process.stderr.write("  hook: no git repo — auto-refresh skipped (run 'gtir refresh' manually)\n");
        break;
      }
      default:
        process.stderr.write([
          "usage: gtir <command> [options]",
          "  gtir init    --repo <project> [--notes|--code] [--no-index] [--no-hook]",
          "  gtir index   --repo <project> [--rebuild] [--no-cache]",
          "  gtir refresh --repo <project> [--no-cache]",
          "  gtir search  --repo <project> <query> [-k N] [--path-prefix P] [--language L]",
          "  gtir status  --repo <project>",
          "  gtir setup   --repo <project>",
          "  gtir hook    --repo <project> [--remove]",
          "  gtir mcp     --repo <project> [--label name:<repo>] [--print-config]",
          "  gtir eval    --repo <project> [--golden <f>] [-k 10] [--save] [--no-build] [--json]",
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
