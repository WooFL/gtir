// src/stale-run.mjs — impure orchestrator for `gtir stale`. Resolves note->code links via the mention-
// bridge, snapshots symbol-body hashes to <wiki>/.gtir/stale-baselines.json, diffs on demand, and emits
// claude-obsidian command-center briefs. Query fns accept injectable deps for testability.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { openStore } from "./store.mjs";
import { codeIndexFor, crossLinks } from "./crosslinks.mjs";
import { snapshotRow, diffBaseline } from "./stale.mjs";
import { hasRefsBlock, upsertRefsBlock, upsertStaleCallout, removeStaleCallout } from "./refs-block.mjs";
import { setFrontmatterFields } from "./frontmatter.mjs";

const BASELINE_NAME = "stale-baselines.json";
function baselinePath(wikiCfg) { return join(wikiCfg.gtirDir, BASELINE_NAME); }

function readBaseline(wikiCfg) {
  const p = baselinePath(wikiCfg);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function writeBaseline(wikiCfg, doc) {
  const p = baselinePath(wikiCfg);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  renameSync(tmp, p);
}

// Resolve EVERY note in the wiki index to its cited code symbols/files, hydrated with full body text and
// snapshotted into rows. Returns { [notePath]: row[] }. Requires a usable code index.
export async function resolveAllNoteRefs(wikiCfg, codeCfg) {
  const wikiStore = await openStore(wikiCfg);
  const manifest = await wikiStore.loadManifest();
  const notePaths = Object.keys(manifest).filter((p) => p.endsWith(".md"));
  const { inv, files } = await codeIndexFor(codeCfg);
  const codeStore = await openStore(codeCfg);
  const out = {};
  for (const note of notePaths) {
    const rows = await wikiStore.chunksByPath(note);
    if (!rows.length) { out[note] = []; continue; }
    const text = rows.map((r) => r.text).join("\n");
    const links = crossLinks(inv, files, text);
    const snapped = [];
    for (const link of links) {
      if (link.kind === "symbol") {
        const sites = inv.byName.get(link.symbol) || [];
        const site = sites.find((s) => s.path === link.path) || sites[0];
        if (!site) continue;
        snapped.push(snapshotRow({
          kind: "symbol", symbol: link.symbol, path: site.path,
          lines: site.line_start != null && site.line_end != null ? `${site.line_start}-${site.line_end}` : link.lines,
          text: site.text || "",
        }));
      } else { // file
        const fileChunks = await codeStore.chunksByPath(link.path);
        const fileText = fileChunks.map((r) => r.text).join("\n");
        snapped.push(snapshotRow({ kind: "file", path: link.path, text: fileText }));
      }
    }
    out[note] = snapped;
  }
  return out;
}

function needCode(codeCfg) {
  return !codeCfg || !codeCfg.indexDir;
}

export async function baselineQuery(wikiCfg, codeCfg, deps = {}) {
  if (needCode(codeCfg) && !deps.resolve) return { error: "stale needs a code index — pass --link-repo <codeRepo>" };
  const resolve = deps.resolve || (() => resolveAllNoteRefs(wikiCfg, codeCfg));
  const links = await resolve();
  const prior = readBaseline(wikiCfg);
  const doc = { version: 1, links, muted: prior?.muted || {} };
  writeBaseline(wikiCfg, doc);
  const linkCount = Object.values(links).reduce((n, r) => n + r.length, 0);
  return { notes: Object.keys(links).length, links: linkCount };
}

export async function checkQuery(wikiCfg, codeCfg, deps = {}) {
  const doc = readBaseline(wikiCfg);
  if (!doc) return { error: "no baseline — run: gtir stale baseline" };
  if (needCode(codeCfg) && !deps.resolve) return { error: "stale needs a code index — pass --link-repo <codeRepo>" };
  const resolve = deps.resolve || (() => resolveAllNoteRefs(wikiCfg, codeCfg));
  const current = await resolve();
  const report = diffBaseline(doc.links, current, doc.muted || {});
  return report;
}

export async function ackQuery(wikiCfg, codeCfg, notePath, deps = {}) {
  const doc = readBaseline(wikiCfg) || { version: 1, links: {}, muted: {} };
  if (!(notePath in doc.links)) return { error: `no baselined note: ${notePath}` };
  if (needCode(codeCfg) && !deps.resolve) return { error: "stale needs a code index — pass --link-repo <codeRepo>" };
  const resolve = deps.resolve || (() => resolveAllNoteRefs(wikiCfg, codeCfg));
  const current = await resolve();
  doc.links[notePath] = current[notePath] || [];
  writeBaseline(wikiCfg, doc);
  return { acked: notePath, links: doc.links[notePath].length };
}

export function muteQuery(wikiCfg, notePath, symbol) {
  const doc = readBaseline(wikiCfg) || { version: 1, links: {}, muted: {} };
  doc.muted = doc.muted || {};
  const list = new Set(doc.muted[notePath] || []);
  list.add(symbol || "*");
  doc.muted[notePath] = [...list];
  writeBaseline(wikiCfg, doc);
  return { muted: { [notePath]: doc.muted[notePath] } };
}

// Deterministic code->note sync. Refreshes the managed refs block in every note that has one, then
// per-symbol re-baselines: `signature` drift (now shown in the table) and undrifted symbols are acked;
// `body`/`removed` drift is LEFT flagged (prose may be wrong — gtir never guesses prose). Flagged notes
// get a stale callout + frontmatter stale:true; clean notes get them cleared. Patches .md files on disk.
// deps: { resolve, readNote, writeNote } are injectable for tests.
export async function syncQuery(wikiCfg, codeCfg, { sha = "unknown", init = false, all = false, notePath = null, deps = {} } = {}) {
  const doc = readBaseline(wikiCfg);
  if (!doc) return { error: "no baseline — run: gtir stale baseline" };
  if (needCode(codeCfg) && !deps.resolve) return { error: "stale needs a code index — pass --link-repo <codeRepo>" };
  const resolve = deps.resolve || (() => resolveAllNoteRefs(wikiCfg, codeCfg));
  const current = await resolve();
  const report = diffBaseline(doc.links, current, doc.muted || {});
  const staleByNote = new Map((report.stale || []).map((s) => [s.note, s.rows]));

  const readNote = deps.readNote || ((p) => { const fp = join(wikiCfg.repo, p); return existsSync(fp) ? readFileSync(fp, "utf8") : null; });
  const writeNote = deps.writeNote || ((p, text) => writeFileSync(join(wikiCfg.repo, p), text, "utf8"));

  const writeErrors = [];

  // --- init: seed a refs block into target notes that lack one (does not re-baseline)
  if (init) {
    const targets = notePath ? [notePath] : (all ? Object.keys(current).filter((n) => (current[n] || []).length) : []);
    for (const note of targets) {
      let text;
      try { text = readNote(note); } catch { writeErrors.push(note); continue; }
      if (text == null) { writeErrors.push(note); continue; }
      if (!hasRefsBlock(text)) {
        try { writeNote(note, upsertRefsBlock(text, current[note] || [], sha)); } catch { writeErrors.push(note); }
      }
    }
  }

  // --- sync: every note with a refs block gets its table refreshed + per-symbol ack + stale toggle
  const synced = [];
  const needsProse = [];
  for (const note of Object.keys(doc.links)) {
    let text;
    try { text = readNote(note); } catch { writeErrors.push(note); continue; }
    if (text == null) { writeErrors.push(note); continue; }
    if (!hasRefsBlock(text)) continue;

    const curRows = current[note] || [];
    const driftRows = staleByNote.get(note) || [];
    const sevBySym = new Map(driftRows.map((r) => [r.symbol, r.severity]));
    const curBySym = new Map(curRows.map((r) => [`${r.symbol}#${r.kind}`, r]));

    text = upsertRefsBlock(text, curRows, sha);

    doc.links[note] = (doc.links[note] || []).map((b) => {
      const sev = sevBySym.get(b.symbol);
      if (sev === "body" || sev === "removed") return b;
      return curBySym.get(`${b.symbol}#${b.kind}`) || b;
    });

    const acked = driftRows.filter((r) => r.severity === "signature").map((r) => r.symbol);
    const flagged = driftRows.filter((r) => r.severity === "body" || r.severity === "removed").map((r) => r.symbol);

    if (flagged.length) {
      text = upsertStaleCallout(text, flagged);
      text = setFrontmatterFields(text, { stale: true, last_synced_sha: sha });
      needsProse.push(note);
    } else {
      text = removeStaleCallout(text);
      text = setFrontmatterFields(text, { stale: false, last_synced_sha: sha });
    }

    try { writeNote(note, text); } catch { writeErrors.push(note); continue; }
    synced.push({ note, refsRefreshed: true, acked, flagged });
  }

  writeBaseline(wikiCfg, doc);
  return { synced, needsProse, writeErrors };
}

// ---- brief adapter (command-center schema). Mirrors tools/command-center/triggers.mjs writeBrief.
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60); }

function alreadyQueued(queueDir, note) {
  const needle = `code-drift-${slug(note)}.md`;
  for (const f of readdirSync(queueDir)) if (f.endsWith(needle)) return true;
  return false;
}

function briefBody(note, rows, sha) {
  const base = note.split("/").pop().replace(/\.md$/, "");
  const blocks = rows.map((r, i) => {
    const now = r.after ? `${r.after.sig || r.after.snippet || ""}` : "symbol no longer exists";
    const was = r.before ? `${r.before.sig || r.before.snippet || ""}` : "";
    const where = r.lines ? `${r.codePath}:${r.lines}` : r.codePath;
    return `${i + 2}. **Code changed** at \`${where}\` — severity **${r.severity}**:
   - BEFORE (baseline): \`${was}\`
   - NOW: \`${now}\``;
  }).join("\n");
  return `# Vault update — code drift in [[${base}]]

The code \`${note}\` cites has changed. Reconcile the affected section(s), then re-baseline.

**Required updates**:

1. **Open \`${note}\`.** The drift is in the section/claim referencing \`${rows.map((r) => r.symbol || r.codePath).join("`, `")}\`.
${blocks}
${rows.length + 2}. **Update the note** so its description matches current code. Keep voice/structure; change only what the code change invalidated (signature → param/return claims; removed → note the removal / find the replacement; body → re-verify behavior claims).
${rows.length + 3}. **Re-baseline** so this stops flagging: \`gtir stale ack "${note}"\`.
${rows.length + 4}. **Delete this brief** when done.

Don't touch \`hot.md\`, \`index.md\`, \`command-center.md\` — auto-managed.
`;
}

// report: output of checkQuery/diffBaseline. queueDir: command-center queue dir. opts.sha: current code HEAD.
export function emitBriefs(report, queueDir, opts = {}) {
  if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true });
  const sha = opts.sha || "unknown";
  const ts = opts.now || 0; // caller may pass a monotonic stamp; dedupe is by note, not ts
  const written = [];
  let i = 0;
  for (const { note, rows } of report.stale || []) {
    if (alreadyQueued(queueDir, note)) continue;
    const priority = rows.some((r) => r.priority === "high") ? "high" : "medium";
    const filename = `${ts + i++}-code-drift-${slug(note)}.md`;
    const fm = [
      "---", "reason: code-drift", `detected_at: ${opts.detectedAt || ""}`, `sha: ${sha}`,
      `priority: ${priority}`, "files:",
      ...[...new Set(rows.map((r) => r.codePath))].map((f) => `  - ${f}`),
      "---", "",
    ].join("\n");
    writeFileSync(join(queueDir, filename), fm + briefBody(note, rows, sha), "utf8");
    written.push(filename);
  }
  return written;
}
