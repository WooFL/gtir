# gtir MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `gtir mcp` stdio MCP server that exposes gtir's existing search as native per-index tools (`search_code`, `search_notes`, …) plus a `gtir_status` tool, so Claude searches code/notes mid-session instead of via Bash.

**Architecture:** A new `src/mcp.mjs` holds pure, dependency-injected logic (label derivation, index resolution, tool registry, JSON-RPC request handler) plus a thin stdio shell wiring the real `search()`/store calls. `bin/gtir.mjs` gains an `mcp` subcommand. Hand-rolled newline-delimited JSON-RPC 2.0 (zero new deps), modeled on the retired `code-mcp/server.mjs`. No new retrieval logic — reuses `search()`, `openStore`, `loadConfig`.

**Tech Stack:** Node ≥20 ESM, `node:test`. Reuses `src/search.mjs`, `src/store.mjs`, `src/config.mjs`.

**Spec:** `docs/superpowers/specs/2026-05-31-gtir-mcp-server-design.md`.

**Reference (read for the transport pattern):** the retired `G:\mediaTraktor\tools\code-mcp\server.mjs` — its stdio loop, `initialize`/`tools/list`/`tools/call` handling, and `structuredContent` result shape are the model.

---

## File Structure

```
src/mcp.mjs          NEW — label utils, resolveIndexes, buildTools, handleRequest (injected),
                           defaultSearchFn/defaultStatusFn, serveStdio, printConfig
bin/gtir.mjs         MODIFY — `mcp` subcommand; repeatable --repo; --label; --print-config; pkgVersion()
test/mcp.test.mjs    NEW — hermetic unit tests (labels, resolve, buildTools, handleRequest w/ fake fns)
README.md            MODIFY — document `gtir mcp`
```

**v1 simplification (deliberate, noted in spec):** no per-index store caching — each
search re-opens the LanceDB store via `search()`. LanceDB connect is ~ms and MCP traffic
is interactive (low QPS), so caching is YAGNI for v1. Documented as a future optimization.

---

## Task 1: label utilities (`sanitizeLabel`, `deriveLabel`)

**Files:**
- Create: `gtir/src/mcp.mjs`
- Test: `gtir/test/mcp.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gtir/test/mcp.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeLabel, deriveLabel } from "../src/mcp.mjs";

test("sanitizeLabel lowercases and collapses non-[a-z0-9_] to _", () => {
  assert.equal(sanitizeLabel("My Wiki!"), "my_wiki");
  assert.equal(sanitizeLabel("engine-core"), "engine_core");
  assert.equal(sanitizeLabel("code"), "code");
  assert.equal(sanitizeLabel("///"), "index"); // empty after strip -> fallback
});

test("deriveLabel: override wins; nomic=>notes; jina-code=>code; else basename", () => {
  assert.equal(deriveLabel("/x/wiki", { model: "nomic-embed-text" }, null), "notes");
  assert.equal(deriveLabel("/x/repo", { model: "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16" }, null), "code");
  assert.equal(deriveLabel("/x/My Repo", { model: "something-else" }, null), "my_repo");
  assert.equal(deriveLabel("/x/repo", { model: "nomic-embed-text" }, "custom"), "custom");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: FAIL — `Cannot find module '../src/mcp.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `gtir/src/mcp.mjs`:

```js
import { resolve, basename } from "node:path";
import { loadConfig } from "./config.mjs";
import { search } from "./search.mjs";
import { openStore } from "./store.mjs";

export function sanitizeLabel(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "index";
}

export function deriveLabel(repo, cfg, override) {
  if (override) return sanitizeLabel(override);
  const m = cfg?.model || "";
  if (/nomic/i.test(m)) return "notes";
  if (/jina.*code/i.test(m)) return "code";
  return sanitizeLabel(basename(repo));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/mcp.mjs test/mcp.test.mjs && git commit -m "feat(gtir): mcp label utilities (sanitize + derive from model)"
```

---

## Task 2: `resolveIndexes`

**Files:**
- Modify: `gtir/src/mcp.mjs`
- Test: `gtir/test/mcp.test.mjs`

Responsibility: turn the `--repo` list + `--label` overrides into `[{label, repo, cfg}]`, loading each repo's config and aborting on label collisions.

- [ ] **Step 1: Write the failing test (append to test/mcp.test.mjs)**

```js
import { resolveIndexes } from "../src/mcp.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function repoWithModel(model) {
  const d = mkdtempSync(join(tmpdir(), "gtir-mcp-"));
  mkdirSync(join(d, ".gtir"), { recursive: true });
  writeFileSync(join(d, ".gtir", "config.json"), JSON.stringify({ model }));
  return d;
}

test("resolveIndexes builds {label,repo,cfg} and applies model-derived labels", () => {
  const code = repoWithModel("hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16");
  const notes = repoWithModel("nomic-embed-text");
  const ix = resolveIndexes([code, notes], {});
  assert.deepEqual(ix.map((i) => i.label), ["code", "notes"]);
  assert.equal(ix[0].cfg.model, "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16");
});

test("resolveIndexes throws on label collision, unless --label disambiguates", () => {
  const a = repoWithModel("nomic-embed-text");
  const b = repoWithModel("nomic-embed-text");
  assert.throws(() => resolveIndexes([a, b], {}), /disambiguate with --label/);
  const ix = resolveIndexes([a, b], { [b]: "notes2" });
  assert.deepEqual(ix.map((i) => i.label).sort(), ["notes", "notes2"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: FAIL — `resolveIndexes is not exported`.

- [ ] **Step 3: Append implementation to `src/mcp.mjs`**

```js
// overrides: { [repoArg]: label }. repos: raw --repo args (loadConfig resolves them).
export function resolveIndexes(repos, overrides = {}) {
  const indexes = [];
  const seen = new Map(); // label -> repo
  for (const repo of repos) {
    const cfg = loadConfig(repo);
    const label = deriveLabel(resolve(repo), cfg, overrides[repo]);
    if (seen.has(label)) {
      throw new Error(
        `two indexes resolved to '${label}' (${seen.get(label)} and ${cfg.repo}) — ` +
        `disambiguate with --label <name>:<repo>`,
      );
    }
    seen.set(label, cfg.repo);
    indexes.push({ label, repo: cfg.repo, cfg });
  }
  return indexes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: PASS — 4 tests total.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/mcp.mjs test/mcp.test.mjs && git commit -m "feat(gtir): mcp resolveIndexes with collision detection"
```

---

## Task 3: `buildTools`

**Files:**
- Modify: `gtir/src/mcp.mjs`
- Test: `gtir/test/mcp.test.mjs`

Responsibility: produce the `tools/list` payload — one `search_<label>` per index plus `gtir_status`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { buildTools } from "../src/mcp.mjs";

test("buildTools emits search_<label> per index plus gtir_status", () => {
  const tools = buildTools([{ label: "code", repo: "/r/code", cfg: {} }, { label: "notes", repo: "/r/wiki", cfg: {} }]);
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ["search_code", "search_notes", "gtir_status"]);
  const search = tools[0];
  assert.deepEqual(search.inputSchema.required, ["query"]);
  assert.ok(search.inputSchema.properties.k);
  assert.ok(search.inputSchema.properties.path_prefix);
  assert.deepEqual(tools[2].inputSchema.properties, {}); // status takes no args
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: FAIL — `buildTools is not exported`.

- [ ] **Step 3: Append implementation to `src/mcp.mjs`**

```js
export function buildTools(indexes) {
  const tools = indexes.map((ix) => ({
    name: `search_${ix.label}`,
    description: `Hybrid semantic + lexical (vector + BM25 + RRF) search over the ${ix.label} index at ${ix.repo}. Returns ranked chunks.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "natural-language search query" },
        k: { type: "integer", description: "max results (default 8)" },
        path_prefix: { type: "string", description: "restrict to paths under this prefix" },
        language: { type: "string", description: "restrict to a language (code indexes)" },
      },
      required: ["query"],
    },
  }));
  tools.push({
    name: "gtir_status",
    description: "List the indexes this gtir MCP server serves, with model, dim, file count, and last-built time.",
    inputSchema: { type: "object", properties: {} },
  });
  return tools;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/mcp.mjs test/mcp.test.mjs && git commit -m "feat(gtir): mcp buildTools (search_<label> + gtir_status)"
```

---

## Task 4: `handleRequest` — initialize / tools/list / unknown method

**Files:**
- Modify: `gtir/src/mcp.mjs`
- Test: `gtir/test/mcp.test.mjs`

Responsibility: the JSON-RPC dispatcher core, dependency-injected (`searchFn`, `statusFn`, `version`). This task covers the non-tool-call methods.

- [ ] **Step 1: Write the failing test (append)**

```js
import { handleRequest } from "../src/mcp.mjs";

const baseCtx = {
  indexes: [{ label: "code", repo: "/r", cfg: {} }],
  searchFn: async () => [],
  statusFn: async () => [],
  version: "9.9.9",
};

test("handleRequest: initialize returns serverInfo + tools capability", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, baseCtx);
  assert.equal(r.result.serverInfo.name, "gtir");
  assert.equal(r.result.serverInfo.version, "9.9.9");
  assert.ok(r.result.capabilities.tools);
});

test("handleRequest: notifications/initialized returns null (no reply)", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, baseCtx);
  assert.equal(r, null);
});

test("handleRequest: tools/list returns the tool set", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, baseCtx);
  assert.deepEqual(r.result.tools.map((t) => t.name), ["search_code", "gtir_status"]);
});

test("handleRequest: unknown method => JSON-RPC -32601", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 3, method: "bogus/x" }, baseCtx);
  assert.equal(r.error.code, -32601);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: FAIL — `handleRequest is not exported`.

- [ ] **Step 3: Append implementation to `src/mcp.mjs`**

```js
export async function handleRequest(msg, ctx) {
  const { indexes, version } = ctx;
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "gtir", version: version ?? "0.0.0" },
      });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return reply({ tools: buildTools(indexes) });
    case "tools/call":
      return reply(await dispatchToolCall(msg.params ?? {}, ctx));
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}
```

(Note: `dispatchToolCall` is added in Task 5. To keep this task's tests green now, also add a temporary stub at the bottom of the file — it will be replaced in Task 5:)

```js
async function dispatchToolCall() { return { content: [{ type: "text", text: "(not implemented)" }], isError: true }; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/mcp.mjs test/mcp.test.mjs && git commit -m "feat(gtir): mcp handleRequest (initialize/tools-list/unknown)"
```

---

## Task 5: `dispatchToolCall` — search + status + errors

**Files:**
- Modify: `gtir/src/mcp.mjs` (replace the `dispatchToolCall` stub; add `formatHits`)
- Test: `gtir/test/mcp.test.mjs`

Responsibility: handle `tools/call` for `search_<label>` (via injected `searchFn`) and `gtir_status` (via `statusFn`), formatting results into MCP `content` + `structuredContent`, with graceful `isError` for unknown tools/indexes and thrown errors.

- [ ] **Step 1: Write the failing test (append)**

```js
const hit = { path: "a.ts", lines: "1-2", language: "ts", score: 0.5, vec_rank: 1, fts_rank: 2, snippet: "code body" };

test("tools/call search_<label> calls searchFn and wraps results", async () => {
  let got = null;
  const ctx = { ...baseCtx, searchFn: async (label, args) => { got = { label, args }; return [hit]; } };
  const r = await handleRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_code", arguments: { query: "find foo", k: 3, path_prefix: "src/" } } }, ctx);
  assert.equal(got.label, "code");
  assert.equal(got.args.query, "find foo");
  assert.equal(got.args.k, 3);
  assert.equal(got.args.pathPrefix, "src/"); // path_prefix mapped to pathPrefix
  assert.deepEqual(r.result.structuredContent.results, [hit]);
  assert.match(r.result.content[0].text, /a\.ts:1-2/);
  assert.match(r.result.content[0].text, /v1\+f2/); // branch annotation
});

test("tools/call gtir_status calls statusFn", async () => {
  const status = [{ label: "code", files: 3, dim: "896" }];
  const ctx = { ...baseCtx, statusFn: async () => status };
  const r = await handleRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "gtir_status", arguments: {} } }, ctx);
  assert.deepEqual(r.result.structuredContent.indexes, status);
});

test("tools/call unknown index => isError", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_missing", arguments: { query: "x" } } }, baseCtx);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /unknown index: missing/);
});

test("tools/call: a thrown searchFn error becomes a graceful isError result", async () => {
  const ctx = { ...baseCtx, searchFn: async () => { throw new Error("ollama down"); } };
  const r = await handleRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_code", arguments: { query: "x" } } }, ctx);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /ollama down/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: FAIL — the stub returns "(not implemented)", so the search/status assertions fail.

- [ ] **Step 3: Replace the `dispatchToolCall` stub in `src/mcp.mjs` and add `formatHits`**

Delete the temporary stub from Task 4 and add:

```js
function formatHits(results) {
  if (!results.length) return "(no matches)";
  return results.map((r) => {
    const branch = [r.vec_rank ? `v${r.vec_rank}` : null, r.fts_rank ? `f${r.fts_rank}` : null].filter(Boolean).join("+") || "—";
    return `### ${r.path}:${r.lines}  _(rrf=${r.score} · ${branch})_\n\`\`\`\n${r.snippet}\n\`\`\``;
  }).join("\n\n");
}

async function dispatchToolCall(params, ctx) {
  const { indexes, searchFn, statusFn } = ctx;
  const name = params.name;
  const args = params.arguments ?? {};
  try {
    if (name === "gtir_status") {
      const status = await statusFn();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], structuredContent: { indexes: status } };
    }
    if (typeof name === "string" && name.startsWith("search_")) {
      const label = name.slice("search_".length);
      if (!indexes.some((ix) => ix.label === label)) {
        return { content: [{ type: "text", text: `unknown index: ${label}` }], isError: true };
      }
      const results = await searchFn(label, {
        query: args.query, k: args.k, pathPrefix: args.path_prefix, language: args.language,
      });
      return { content: [{ type: "text", text: formatHits(results) }], structuredContent: { results } };
    }
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: PASS — 13 tests. Then full suite: `cd /g/demon/gtir && node --test`.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/mcp.mjs test/mcp.test.mjs && git commit -m "feat(gtir): mcp tool dispatch (search + status) with graceful errors"
```

---

## Task 6: real wiring — `defaultSearchFn`, `defaultStatusFn`, `serveStdio`, `printConfig`

**Files:**
- Modify: `gtir/src/mcp.mjs`
- Test: `gtir/test/mcp.test.mjs`

Responsibility: the un-injected production wiring. `defaultSearchFn`/`defaultStatusFn` call the real `search()`/`openStore`. `serveStdio` runs the newline-delimited JSON-RPC loop over stdin/stdout. `printConfig` emits the `.mcp.json` snippet. Only `printConfig` is unit-tested (the rest is covered by the live smoke in Task 7, since they require Ollama/stdin).

- [ ] **Step 1: Write the failing test (append)**

```js
import { printConfig } from "../src/mcp.mjs";

test("printConfig emits a stdio .mcp.json snippet with node + the repos", () => {
  const snippet = JSON.parse(printConfig(["G:/p/code", "G:/p/wiki"]));
  assert.equal(snippet.gtir.type, "stdio");
  assert.equal(snippet.gtir.command, "node");
  assert.match(snippet.gtir.args.join(" "), /bin\/gtir\.mjs mcp/);
  assert.ok(snippet.gtir.args.includes("G:/p/code"));
  assert.ok(snippet.gtir.args.includes("G:/p/wiki"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: FAIL — `printConfig is not exported`.

- [ ] **Step 3: Append implementation to `src/mcp.mjs`**

Add this import near the top of `src/mcp.mjs` (with the existing imports):

```js
import { fileURLToPath } from "node:url";
```

Then append:

```js
export function defaultSearchFn(indexes) {
  return async (label, args) => {
    const ix = indexes.find((i) => i.label === label);
    return search(args.query, ix.cfg, { k: args.k, pathPrefix: args.pathPrefix, language: args.language });
  };
}

export function defaultStatusFn(indexes) {
  return async () => Promise.all(indexes.map(async (ix) => {
    const store = await openStore(ix.cfg);
    const meta = await store.readMeta();
    const man = await store.loadManifest();
    const builtAt = Number(meta.built_at) || 0;
    return {
      label: ix.label, repo: ix.repo,
      model: meta.model ?? ix.cfg.model, dim: meta.dim ?? null,
      files: Object.keys(man).length, built_at: builtAt,
      age_minutes: builtAt ? Math.round((Date.now() / 1000 - builtAt) / 60) : null,
      healthy: !!meta.dim,
    };
  }));
}

export function serveStdio(indexes, { version } = {}) {
  const ctx = { indexes, searchFn: defaultSearchFn(indexes), statusFn: defaultStatusFn(indexes), version };
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const res = await handleRequest(msg, ctx);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  });
  process.stderr.write(`gtir mcp: serving ${indexes.map((i) => `search_${i.label}`).join(", ")}, gtir_status\n`);
}

export function printConfig(repos) {
  const gtirBin = fileURLToPath(new URL("../bin/gtir.mjs", import.meta.url)).split("\\").join("/");
  const args = ["mcp"];
  for (const r of repos) args.push("--repo", r);
  return JSON.stringify({ gtir: { type: "stdio", command: "node", args: [gtirBin, ...args] } }, null, 2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/mcp.test.mjs`
Expected: PASS — 14 tests. Then full suite: `cd /g/demon/gtir && node --test`.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/mcp.mjs test/mcp.test.mjs && git commit -m "feat(gtir): mcp real wiring — serveStdio, default search/status, printConfig"
```

---

## Task 7: CLI wiring + live smoke + README

**Files:**
- Modify: `gtir/bin/gtir.mjs`
- Modify: `gtir/README.md`
- Test: `gtir/test/cli.test.mjs` (add a `--print-config` test)

Responsibility: add the `mcp` subcommand (repeatable `--repo`, `--label name:path`, `--print-config`), wire `serveStdio`, read the package version, document it, and prove the CLI path with a non-blocking `--print-config` test plus a documented live smoke.

- [ ] **Step 1: Add the `--print-config` CLI test (append to `gtir/test/cli.test.mjs`)**

```js
import { execFileSync } from "node:child_process";
import { fileURLToPath as f2 } from "node:url";
import { dirname as d2, join as j2 } from "node:path";

test("gtir mcp --print-config prints a valid .mcp.json snippet and exits", () => {
  const bin = j2(d2(f2(import.meta.url)), "..", "bin", "gtir.mjs");
  const out = execFileSync("node", [bin, "mcp", "--repo", "G:/p/code", "--repo", "G:/p/wiki", "--print-config"], { encoding: "utf8" });
  const snippet = JSON.parse(out);
  assert.equal(snippet.gtir.command, "node");
  assert.ok(snippet.gtir.args.includes("G:/p/code"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/cli.test.mjs`
Expected: FAIL — `mcp` is an unknown command (prints usage, exit 1) → `execFileSync` throws / output isn't JSON.

- [ ] **Step 3: Wire `bin/gtir.mjs`**

Add the import (with the other `../src/...` imports near the top):

```js
import { resolveIndexes, serveStdio, printConfig } from "../src/mcp.mjs";
import { readFileSync } from "node:fs";
```

Add a version helper just below the imports (before `runIndex`):

```js
function pkgVersion() {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; }
  catch { return "0.0.0"; }
}
```

In `parseArgs`, replace the single `--repo` line:

```js
    else if (a === "--repo") args.repo = argv[++i];
```

with repeatable collection plus the new flags:

```js
    else if (a === "--repo") { const v = argv[++i]; args.repo = v; (args.repos ??= []).push(v); }
    else if (a === "--label") {
      const v = argv[++i] ?? "";
      const c = v.indexOf(":");
      if (c > 0) { (args.labels ??= {})[v.slice(c + 1)] = v.slice(0, c); }
    }
    else if (a === "--print-config") args.printConfig = true;
```

Add the `mcp` case in the dispatch `switch` (right after the `hook` case):

```js
      case "mcp": {
        const repos = args.repos ?? (args.repo ? [args.repo] : []);
        if (repos.length === 0) { process.stderr.write("gtir mcp: pass at least one --repo <path>\n"); process.exit(2); }
        if (args.printConfig) { process.stdout.write(printConfig(repos) + "\n"); break; }
        const indexes = resolveIndexes(repos, args.labels ?? {});
        serveStdio(indexes, { version: pkgVersion() });
        return; // keep the process alive on stdin; do not fall through to exit
      }
```

Update the usage line to include `mcp` and the new flags:

```js
        process.stderr.write("usage: gtir <init|index|refresh|search|status|setup|hook|mcp> [--repo <path>] [--notes|--code] [--label name:<repo>] [--print-config] [--rebuild] [--no-index] [--no-hook] [-k N] [--path-prefix P] [--language L] [--remove]\n");
```

- [ ] **Step 4: Run the CLI test + full suite**

Run: `cd /g/demon/gtir && node --test test/cli.test.mjs` → PASS.
Run: `cd /g/demon/gtir && node --test` → PASS (all suites).

- [ ] **Step 5: Live smoke (manual — requires Ollama + a built index)**

Run, against the real MediaTraktor indexes:

```bash
# print the registration snippet
node bin/gtir.mjs mcp --repo "G:/mediaTraktor" --repo "G:/mediaTraktor/wiki" --print-config

# drive the server over stdio (initialize -> tools/list -> a search)
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"hybrid retrieval","k":3}}}' \
 | node bin/gtir.mjs mcp --repo "G:/mediaTraktor" --repo "G:/mediaTraktor/wiki"
```

Expected: a JSON-RPC `initialize` result with `serverInfo.name:"gtir"`, then a `tools/call` result whose `structuredContent.results` lists ranked wiki chunks. (The process stays open on stdin; Ctrl-C to exit.)

- [ ] **Step 6: Update `README.md`**

Add this section after the `## Use` block in `gtir/README.md`:

```markdown
## MCP server (use gtir from inside Claude)

Expose gtir's search as native MCP tools so Claude can call them mid-session:

    gtir mcp --repo <codeRepo> --repo <wikiRepo>

It serves one tool per index — `search_code`, `search_notes` (auto-labeled from each
index's model; override with `--label name:<repo>`) — plus `gtir_status`. Register it by
pasting the snippet from:

    gtir mcp --repo <codeRepo> --repo <wikiRepo> --print-config

into your project's `.mcp.json` (`mcpServers`). The server is stdio JSON-RPC, zero extra
deps, and adds no new retrieval logic — it wraps the same hybrid search as the CLI.
```

- [ ] **Step 7: Commit**

```bash
cd /g/demon/gtir && git add bin/gtir.mjs test/cli.test.mjs README.md && git commit -m "feat(gtir): wire 'gtir mcp' subcommand + --print-config + docs"
```

---

## Self-Review (against the spec)

**Spec coverage:**
- `gtir mcp --repo ...` starts stdio server → Task 7 (CLI) + Task 6 (`serveStdio`). ✅
- Named per-index `search_<label>` tools → Tasks 3 (buildTools), 5 (dispatch). ✅
- `gtir_status` tool → Tasks 3, 5, 6 (`defaultStatusFn`). ✅
- Auto-label from model + `--label` override + collision abort → Tasks 1 (deriveLabel), 2 (resolveIndexes), 7 (`--label` parse). ✅
- `--print-config` snippet (node + abs path) → Task 6 (`printConfig`), 7 (CLI). ✅
- Hand-rolled JSON-RPC (initialize/initialized/tools-list/tools-call/unknown) → Tasks 4, 5, 6. ✅
- Dependency-injected `handleRequest` for hermetic tests → Tasks 4, 5 (fake `searchFn`/`statusFn`). ✅
- Graceful tool errors (`isError`), not crashes → Task 5 (try/catch, unknown index/tool). ✅
- Result shape `{path,lines,language,score,vec_rank,fts_rank,snippet}` + markdown → Task 5 (`formatHits`, `structuredContent`). ✅
- Reuses `search`/`openStore`/`readMeta`/`loadManifest`/`loadConfig`, no new retrieval → Tasks 2, 6. ✅
- `serverInfo.version` from package.json (spec open question resolved) → Task 7 (`pkgVersion`). ✅
- v1 simplification (no store cache) → noted in File Structure; `defaultSearchFn` calls `search()` directly. ✅

**Placeholder scan:** The Task 4 `dispatchToolCall` stub is explicitly temporary and replaced in Task 5 (not a placeholder-in-final-code) — flagged in both tasks. No TBD/vague steps; every code step shows complete code.

**Type/name consistency:** `{label, repo, cfg}` index shape consistent across resolveIndexes → buildTools → handleRequest → defaultSearchFn/StatusFn. `searchFn(label, {query,k,pathPrefix,language})` signature consistent between the Task 5 test, `dispatchToolCall` (maps `path_prefix`→`pathPrefix`), and `defaultSearchFn`. Tool names `search_<label>`/`gtir_status` consistent across buildTools and dispatch. `handleRequest(msg, ctx)` / `ctx={indexes,searchFn,statusFn,version}` consistent across Tasks 4–6.
