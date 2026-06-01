// `gtir demo` — show the payoff in one screen: a plain-English query, the noisy pile grep
// returns, and gtir's single right answer (matched by meaning), with a real token comparison.
// All numbers are COMPUTED, not canned: the grep scan runs over the same files gtir indexed,
// the hit comes from a real search, and token counts are measured from the actual text.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { buildIndex } from "./indexer.mjs";
import { search } from "./search.mjs";
import { openStore } from "./store.mjs";
import { walkRepo } from "./walker.mjs";

// The default tour: a query whose answer (the levenshtein function) it never names — the
// textbook semantic-search case, and a single clean function so the meaning gap is unmistakable.
export const DEMO_QUERY = "compute the edit distance between two strings";

const STOP = new Set(
  "a an and are as at be by do for from how in into is it of on or our that the this to we what when where which with you your".split(" "),
);

// ~4 chars/token is the rule-of-thumb for English+code; accepts a string or a char count.
export function estimateTokens(textOrLen) {
  const len = typeof textOrLen === "number" ? textOrLen : String(textOrLen || "").length;
  return Math.max(0, Math.ceil(len / 4));
}

// The keyword an engineer would actually grep for: the longest distinctive (non-stopword) term.
export function pickGrepTerm(query, override = null) {
  if (override) return override;
  const words = (String(query).toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []).filter((w) => !STOP.has(w));
  return words.sort((a, b) => b.length - a.length)[0] || "";
}

// Case-insensitive, non-overlapping occurrence count — the "grep -rin" tally for one file.
export function countMatches(text, term) {
  if (!term) return 0;
  const hay = String(text).toLowerCase(), needle = term.toLowerCase();
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// First declared identifier in a snippet (best-effort, cross-language) — the answer's "name".
export function declaredSymbol(snippet) {
  // Match real declaring keywords only — NOT modifiers like export/public/pub, which precede
  // the keyword (else "export function foo" would capture "function").
  const m = String(snippet || "").match(
    /\b(?:function|func|def|class|fn|interface|type|struct|impl|trait|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  );
  return m ? m[1] : null;
}

// The "you never said X" hook: a symbol the result defines that the query never mentions.
export function meaningGap(query, snippet) {
  const sym = declaredSymbol(snippet);
  if (sym && !String(query).toLowerCase().includes(sym.toLowerCase())) return { kind: "symbol", symbol: sym };
  return { kind: "vocab" };
}

function grepCorpus(cfg, term) {
  let matches = 0;
  const hitFiles = [];
  for (const f of walkRepo(cfg)) {
    let text;
    try { text = readFileSync(f.absPath, "utf8"); } catch { continue; }
    const c = countMatches(text, term);
    if (c > 0) { matches += c; hitFiles.push({ relPath: f.relPath, bytes: text.length }); }
  }
  return { matches, hitFiles };
}

const sanitize = (s) => String(s).replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
const bundledCorpus = () => fileURLToPath(new URL("../eval/corpus", import.meta.url));

// Build (once, cached in tmp) or reuse an index, run the query + grep, return computed metrics.
export async function runDemo({ repo = null, query = null, grepTerm = null, k = 5, log = () => {} } = {}) {
  const bundled = !repo;
  const corpus = repo || bundledCorpus();
  const q = (query && query.trim()) || DEMO_QUERY;
  const term = pickGrepTerm(q, grepTerm);

  let cfg;
  if (bundled) {
    const base = loadConfig(corpus);
    const root = join(tmpdir(), "gtir-demo", sanitize(base.model));
    cfg = { ...base, repo: corpus, gtirDir: root, indexDir: join(root, "index.lance") };
    const store = await openStore(cfg);
    const tbl = await store.chunksTable();
    const meta = tbl ? await store.readMeta() : null;
    if (!tbl || meta?.model !== cfg.model) {
      log(`indexing ${walkRepo(cfg).length} sample files (one-time, via Ollama)…`);
      await buildIndex(cfg, { rebuild: true });
    }
  } else {
    cfg = loadConfig(repo);
    const store = await openStore(cfg);
    if (!(await store.chunksTable())) throw new Error(`no index at ${cfg.indexDir} — run: gtir index --repo ${repo}`);
  }

  const hits = await search(q, cfg, { k });
  const grep = grepCorpus(cfg, term);
  const top = hits[0] || null;
  // Honest "find-the-code" cost: with grep you read the files it hit to disambiguate; with gtir
  // you read the one span it points you at. That's exactly what the two sides of the demo show.
  const gtirTokens = top ? estimateTokens(top.snippet) : 0;
  const grepTokens = grep.hitFiles.reduce((s, f) => s + estimateTokens(f.bytes), 0);
  return {
    query: q, term, corpus, bundled, hits, grep, gtirTokens, grepTokens, top,
    gap: top ? meaningGap(q, top.snippet) : null,
    ratio: gtirTokens > 0 ? grepTokens / gtirTokens : null,
  };
}

// --- rendering -------------------------------------------------------------

const paint = (code, s, on) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

function fmtTok(n) {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}

function snippetLines(snippet, max = 4, width = 56) {
  return String(snippet || "")
    .split("\n").map((l) => l.replace(/\t/g, "  ").trimEnd())
    .filter((l) => l.trim().length)
    .slice(0, max)
    .map((l) => (l.length > width ? l.slice(0, width - 1) + "…" : l));
}

function box(lines, color) {
  const w = Math.max(...lines.map((l) => l.length), 1);
  const rows = ["┌─" + "─".repeat(w) + "─┐",
    ...lines.map((l) => "│ " + l + " ".repeat(w - l.length) + " │"),
    "└─" + "─".repeat(w) + "─┘"];
  return rows.map((l) => paint(36, l, color));
}

export function formatDemo(r, { color = false } = {}) {
  const dim = (s) => paint(2, s, color);
  const grn = (s) => paint(32, s, color);
  const bold = (s) => paint(1, s, color);
  const ylw = (s) => paint(33, s, color);
  const out = ["", `  ${bold(`❓  "${r.query}"`)}`, ""];

  const sample = r.grep.hitFiles.slice(0, 3).map((f) => f.relPath).join(", ");
  const more = r.grep.hitFiles.length > 3 ? ", …" : "";
  out.push("      " + dim(`grep -rin ${r.term}`) + "   →  " +
    dim(`${r.grep.matches} matches in ${r.grep.hitFiles.length} files`) + (sample ? dim(`  (${sample}${more})`) : ""));

  if (!r.top) {
    out.push("      " + grn("gtir search") + "   →  (no results)", "");
    return out.join("\n") + "\n";
  }

  out.push("      " + grn("gtir search") + "   →  " + grn("top hit:"), "");
  out.push("         " + bold(`${r.top.path}:${r.top.lines}`));
  for (const l of box(snippetLines(r.top.snippet), color)) out.push("         " + l);
  out.push("         " + grn(r.gap?.kind === "symbol"
    ? `↑ matched by meaning — your query never said "${r.gap.symbol}"`
    : "↑ matched by meaning — different words, same intent"));
  out.push("");

  const ratio = r.ratio && r.ratio > 1 ? `≈ ${Math.round(r.ratio)}× less` : "less to read";
  out.push("  to find it, you read:   " + dim(`grep → ${fmtTok(r.grepTokens)} tokens (the files it hit)`) +
    "   ·   " + grn(`gtir → ${fmtTok(r.gtirTokens)} (one span)`) + "   " + ylw(`(${ratio})`), "");
  return out.join("\n") + "\n";
}
