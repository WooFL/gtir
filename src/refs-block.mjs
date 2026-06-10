// src/refs-block.mjs — gtir-managed regions inside a wiki note. Pure (built on marked-section).
//   <!-- gtir:refs -->  … live refs table …  <!-- /gtir:refs -->   (factual, regenerated on sync)
//   <!-- gtir:stale --> … drift callout …    <!-- /gtir:stale -->  (added when prose may be stale)
import { upsertMarkedSection, removeMarkedSection } from "./marked-section.mjs";

export const REFS_START = "<!-- gtir:refs -->";
export const REFS_END = "<!-- /gtir:refs -->";
export const STALE_START = "<!-- gtir:stale -->";
export const STALE_END = "<!-- /gtir:stale -->";

// Escape a value for a markdown table cell: literal pipes would split the cell; newlines would break the row.
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

// Render the refs table from snapshot rows ({symbol, path, lines, kind, sig?}). Footer carries the sha.
export function renderRefsTable(rows, sha) {
  const head = "| symbol | location | signature |\n|---|---|---|";
  const list = Array.isArray(rows) ? rows : [];
  const body = list.length
    ? list.map((r) => {
        if (r.kind === "file" || !r.symbol) return `| \`(file)\` | ${cell(r.path)} | — |`;
        const loc = r.lines ? `${r.path}:${r.lines}` : r.path;
        return `| \`${cell(r.symbol)}\` | ${cell(loc)} | \`${cell(r.sig || "")}\` |`;
      }).join("\n")
    : "| _(no resolved code refs)_ | — | — |";
  return `${head}\n${body}\n\n_synced ${sha}_`;
}

// The drift callout body: an Obsidian warning callout naming the symbols whose prose may be stale.
export function renderStaleCallout(symbols) {
  const list = (symbols || []).map((s) => `\`${s}\``).join(", ");
  return `> [!warning] gtir: cited code drifted — review prose for: ${list}`;
}

export function upsertRefsBlock(text, rows, sha) {
  return upsertMarkedSection(text, REFS_START, REFS_END, renderRefsTable(rows, sha));
}
export function removeRefsBlock(text) {
  return removeMarkedSection(text, REFS_START, REFS_END);
}
export function hasRefsBlock(text) {
  return typeof text === "string" && text.includes(REFS_START);
}

export function upsertStaleCallout(text, symbols) {
  return upsertMarkedSection(text, STALE_START, STALE_END, renderStaleCallout(symbols));
}
export function removeStaleCallout(text) {
  return removeMarkedSection(text, STALE_START, STALE_END);
}
