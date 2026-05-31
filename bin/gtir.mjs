#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { loadConfig } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { search } from "../src/search.mjs";
import { openStore } from "../src/store.mjs";
import { installHook, removeHook } from "../src/hook.mjs";
import { probeDim } from "../src/embed.mjs";
import { runInit } from "../src/init.mjs";

// --- programmatic entrypoints (used by tests and the dispatcher) ---

export async function runIndex({ repo, rebuild = false, embedImpl = null } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
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
    else if (a === "--repo") args.repo = argv[++i];
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
    else if (a === "--no-index") args.noIndex = true;
    else if (a === "--no-hook") args.noHook = true;
    else args._.push(a);
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const repo = args.repo || process.cwd();

  try {
    switch (cmd) {
      case "index": {
        const r = await runIndex({ repo, rebuild: !!args.rebuild });
        process.stderr.write(`gtir: indexed ${r.chunks} chunks (${r.skipped} skipped, ${r.evicted} evicted), dim=${r.dim}\n`);
        break;
      }
      case "refresh": {
        const r = await runIndex({ repo, rebuild: false });
        process.stderr.write(`gtir: refresh — ${r.chunks} chunks updated (${r.skipped} skipped, ${r.evicted} evicted)\n`);
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
        process.stderr.write("usage: gtir <init|index|refresh|search|status|setup|hook> [--repo <path>] [--notes|--code] [--rebuild] [--no-index] [--no-hook] [-k N] [--path-prefix P] [--language L] [--remove]\n");
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
