// Pure retrieval-eval helpers — no I/O, no DB. Search results are injected.

const round = (x) => Number(x.toFixed(4));

// Parse search()'s "start-end" line string into [start, end].
// Tolerant of a single number ("7" -> [7,7]), surrounding whitespace, and a [s,e] array.
export function parseLines(s) {
  if (Array.isArray(s)) return [Number(s[0]), Number(s[1] ?? s[0])];
  const str = String(s).trim();
  const m = str.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = Number(str);
  return Number.isFinite(n) ? [n, n] : [NaN, NaN];
}

// Inclusive range overlap: [as,ae] overlaps [bs,be] iff as <= be && bs <= ae.
export function overlaps(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}
