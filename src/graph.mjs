// Pure edge-graph shaping for `gtir graph`. No I/O — buildGraph/renderHtml take data in,
// return data/HTML out, so the whole module is unit-testable offline without a browser.

const NOTE_KINDS = new Set(["links", "embeds"]);

const base = (p) => String(p).split(/[\\/]/).pop();
const noteName = (p, sym) => sym || base(p).replace(/\.(md|mdx)$/i, "");

// First line number from a "start-end" / "start" lines string (0 when absent).
function lineOf(lines) {
  const m = String(lines ?? "").match(/^\d+/);
  return m ? Number(m[0]) : 0;
}

// FROM-side node descriptor for an edge.
function fromNode(e) {
  if (NOTE_KINDS.has(e.kind)) {
    const name = noteName(e.from_path, e.from_symbol);
    return { id: `note:${name}`, label: `[[${name}]]`, cls: "note", ref: { path: e.from_path, line: lineOf(e.from_lines) } };
  }
  if (e.from_symbol) {
    return { id: `${e.from_symbol}\x00${e.from_path}`, label: `${e.from_symbol} · ${e.from_path}`, cls: "code", ref: { path: e.from_path, line: lineOf(e.from_lines) } };
  }
  return { id: e.from_path, label: e.from_path, cls: "code", ref: { path: e.from_path, line: lineOf(e.from_lines) } };
}

// TO-side node descriptor. Resolved → real target; non-resolved → named synthetic node
// keyed by ref_name (degrading to a shared "" sink when ref_name is null, i.e. a stale index).
function toNode(e) {
  if (e.conf === "resolved") {
    if (NOTE_KINDS.has(e.kind)) {
      const name = e.ref_name || e.to_symbol || base(e.to_path);
      return { id: `note:${name}`, label: `[[${name}]]`, cls: "note", ref: { path: e.to_path, line: 0 } };
    }
    if (e.to_symbol) {
      return { id: `${e.to_symbol}\x00${e.to_path}`, label: `${e.to_symbol} · ${e.to_path}`, cls: "code", ref: { path: e.to_path, line: lineOf(e.to_lines) } };
    }
    return { id: e.to_path, label: e.to_path, cls: "code", ref: { path: e.to_path, line: 0 } };
  }
  const name = e.ref_name || "";
  if (e.conf === "external") {
    return { id: `ext:${name}`, label: name || "(external)", cls: "external", ref: null, candidates: e.candidates };
  }
  return { id: `amb:${name}`, label: name || "(ambiguous)", cls: "ambiguous", ref: null, candidates: e.candidates };
}

// The symbol a node represents, for --focus matching: the function/import/note/target name,
// independent of the file it lives in.
function symbolOf(node) {
  const id = node.id;
  if (id.includes("\x00")) return id.split("\x00")[0];
  if (id.startsWith("ext:")) return id.slice(4);
  if (id.startsWith("amb:")) return id.slice(4);
  if (id.startsWith("note:")) return id.slice(5);
  return base(id); // bare file node
}

// Induced subgraph within `depth` undirected hops of every node whose symbol equals `focus`.
export function egoGraph({ nodes, edges }, focus, depth = 2) {
  const roots = nodes.filter((n) => symbolOf(n) === focus).map((n) => n.id);
  if (roots.length === 0) return { nodes: [], edges: [] };

  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const e of edges) { link(e.source, e.target); link(e.target, e.source); }

  const keep = new Set(roots);
  let frontier = roots;
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) for (const nb of adj.get(id) ?? []) if (!keep.has(nb)) { keep.add(nb); next.push(nb); }
    frontier = next;
    if (!frontier.length) break;
  }
  return {
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

// Keep only edges matching the kind / conf / pathPrefix filters (each optional).
// Operates on RAW edge rows (pre-mapEdges) — mapEdges drops from_path, so always filter first.
export function applyFilters(edges, { kind = null, conf = null, pathPrefix = null } = {}) {
  const kindSet = kind ? new Set(kind) : null;
  const confSet = conf ? new Set(conf) : null;
  return edges.filter((e) =>
    (!kindSet || kindSet.has(e.kind)) &&
    (!confSet || confSet.has(e.conf)) &&
    (!pathPrefix || String(e.from_path ?? "").startsWith(pathPrefix)));
}

// Cap node count by dropping the lowest-degree nodes (and their incident edges). Returns the
// graph plus { truncated, dropped }. Used only for the whole-repo view; focus is already bounded.
export function capByDegree({ nodes, edges }, maxNodes) {
  if (nodes.length <= maxNodes) return { nodes, edges, truncated: false, dropped: 0 };
  const degree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const keep = new Set(
    [...nodes].sort((a, b) => (degree.get(b.id) - degree.get(a.id)))
      .slice(0, maxNodes).map((n) => n.id));
  const keptNodes = nodes.filter((n) => keep.has(n.id));
  return {
    nodes: keptNodes,
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    truncated: true,
    dropped: nodes.length - keptNodes.length,
  };
}

// Confidence severity for rollup merges: ambiguous (a wrong guess) is the audit target, so it
// dominates; external (correctly outside the index) next; resolved is the baseline.
const SEVERITY = { resolved: 0, external: 1, ambiguous: 2 };
export function worstConf(a, b) { return SEVERITY[b] > SEVERITY[a] ? b : a; }

// Re-key code symbol nodes to their file; synthetic ext:/amb: and note: nodes pass through.
// Parallel edges merge by (source,target,kind), keeping the worst conf and summing a count
// used downstream as stroke width.
export function rollupToFiles({ nodes, edges }) {
  const fileId = (n) => (n.cls === "code" && n.id.includes("\x00")) ? n.id.split("\x00")[1] : n.id;
  const fileLabel = (n) => (n.cls === "code" && n.id.includes("\x00")) ? n.id.split("\x00")[1] : n.label;

  const out = new Map();
  for (const n of nodes) {
    const id = fileId(n);
    let cur = out.get(id);
    if (!cur) { cur = { id, label: fileLabel(n), cls: n.cls, refs: [], candidates: [] }; out.set(id, cur); }
    for (const r of n.refs) if (!cur.refs.some((x) => x.path === r.path && x.line === r.line)) cur.refs.push(r);
    for (const c of n.candidates) if (!cur.candidates.includes(c)) cur.candidates.push(c);
  }

  const idOf = new Map(nodes.map((n) => [n.id, fileId(n)]));
  const merged = new Map();
  for (const e of edges) {
    const s = idOf.get(e.source), t = idOf.get(e.target);
    if (s === t) continue; // self-loop after collapse — drop
    const key = `${s}\x00${t}\x00${e.kind}`;
    const cur = merged.get(key);
    if (cur) { cur.count += 1; cur.conf = worstConf(cur.conf, e.conf); }
    else merged.set(key, { source: s, target: t, kind: e.kind, conf: e.conf, count: 1 });
  }
  return { nodes: [...out.values()], edges: [...merged.values()] };
}

// Incident-edge count per node. Pure: returns NEW node objects with `degree` added.
export function withDegree(nodes, edges) {
  const deg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  return nodes.map((n) => ({ ...n, degree: deg.get(n.id) ?? 0 }));
}

// Cluster key from the directory a node lives in: the dirname's first two segments
// (packages/ui), or the first one, or "(root)" for a top-level file. Synthetic nodes
// cluster to their kind; notes cluster to their top folder.
function clusterFromPath(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  parts.pop(); // drop the filename — cluster by directory
  if (parts.length === 0) return "(root)";
  return parts.slice(0, 2).join("/");
}

export function clusterOf(node) {
  const id = node.id;
  if (id.startsWith("ext:")) return "external";
  if (id.startsWith("amb:")) return "ambiguous";
  if (id.startsWith("note:")) {
    const ref = node.refs && node.refs[0] && node.refs[0].path;
    return ref ? clusterFromPath(ref) : "notes";
  }
  const path = id.includes("\x00") ? id.split("\x00")[1] : id;
  return clusterFromPath(path);
}

// Compose the pipeline: filter → map → focus|cap, with rollup placed so the cap acts on the
// FINAL node grain. Focus: bound by depth first, then collapse the small ego-graph. Whole-repo:
// collapse to files BEFORE capping so the cap keeps the highest-degree FILES (a real file-level
// overview) rather than the highest-degree symbols that happen to survive a symbol-grain cap.
export function buildGraph(edges, opts = {}) {
  const { focus = null, depth = 2, rollup = false, kind = null, conf = null, pathPrefix = null, maxNodes = Infinity } = opts;
  const rows = applyFilters(edges, { kind, conf, pathPrefix });
  let g = mapEdges(rows);
  let truncated = false, dropped = 0;

  if (focus) {
    g = egoGraph(g, focus, depth);
    if (rollup) g = rollupToFiles(g);
  } else {
    if (rollup) g = rollupToFiles(g);
    const capped = capByDegree(g, maxNodes);
    g = { nodes: capped.nodes, edges: capped.edges };
    truncated = capped.truncated; dropped = capped.dropped;
  }

  const nodes = withDegree(g.nodes, g.edges).map((n) => ({ ...n, cluster: clusterOf(n) }));
  return { nodes, edges: g.edges, truncated, dropped };
}

const CONF_COLOR = { resolved: "#3fb950", ambiguous: "#d29922", external: "#8b949e" };
const CLS_COLOR = { code: "#58a6ff", note: "#bc8cff", external: "#8b949e", ambiguous: "#d29922" };

// JSON for embedding in a <script> — escape `<` so a "</script>" inside any string can't close the tag.
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

export function renderHtml({ nodes, edges, meta = {} }, d3Source) {
  const data = safeJson({ nodes, edges });
  const colors = safeJson({ conf: CONF_COLOR, cls: CLS_COLOR });
  const trunc = meta.truncated ? `truncated: dropped ${meta.dropped ?? 0}` : "";
  const d3Safe = String(d3Source).replace(/<\/script>/gi, "<\\/script>");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>gtir graph</title>
<style>
  html,body{margin:0;height:100%;background:#0d1117;color:#c9d1d9;font:13px system-ui,sans-serif}
  #chrome{position:fixed;top:8px;left:8px;z-index:10;background:#161b22cc;border:1px solid #30363d;border-radius:6px;padding:8px 10px;max-width:240px}
  #chrome h1{font-size:13px;margin:0 0 6px}
  #search{width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:4px;padding:4px}
  .legend{margin-top:8px;line-height:1.6}
  .sw{display:inline-block;width:22px;height:0;border-top-width:3px;border-top-style:solid;vertical-align:middle;margin-right:6px}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;margin-right:6px}
  #trunc{color:#d29922;margin-top:6px}
  #tip{position:fixed;z-index:20;pointer-events:none;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:6px 8px;display:none;max-width:340px}
  svg{width:100vw;height:100vh;display:block}
  text{fill:#8b949e;font-size:10px;pointer-events:none}
  .node circle{cursor:pointer}
  .dim{opacity:0.12}
</style></head>
<body>
<div id="chrome">
  <h1>gtir graph</h1>
  <input id="search" placeholder="find node…" autocomplete="off">
  <div class="legend">
    <div><span class="sw" style="border-top-color:${CONF_COLOR.resolved}"></span>resolved</div>
    <div><span class="sw" style="border-top-color:${CONF_COLOR.ambiguous}"></span>ambiguous</div>
    <div><span class="sw" style="border-top-color:${CONF_COLOR.external}"></span>external</div>
    <div style="margin-top:4px"><span class="sw" style="border-top-color:#8b949e"></span>calls — / imports ┄ / links ··</div>
    <div style="margin-top:4px"><span class="dot" style="background:${CLS_COLOR.code}"></span>code <span class="dot" style="background:${CLS_COLOR.note};margin-left:8px"></span>note</div>
  </div>
  <div id="trunc">${trunc}</div>
</div>
<div id="tip"></div>
<svg></svg>
<script>${d3Safe}</script>
<script>
window.__GTIR_GRAPH__ = ${data};
const COLORS = ${colors};
const { nodes, edges } = window.__GTIR_GRAPH__;
const links = edges.map(e => ({ ...e }));
const dash = k => k === "imports" ? "6,4" : (k === "links" || k === "embeds") ? "1,4" : null;

const svg = d3.select("svg");
const g = svg.append("g");
svg.call(d3.zoom().scaleExtent([0.1, 4]).on("zoom", ev => g.attr("transform", ev.transform)));

const link = g.append("g").attr("stroke-opacity", 0.7).selectAll("line").data(links).join("line")
  .attr("stroke", d => COLORS.conf[d.conf]).attr("stroke-width", d => Math.min(6, (d.count || 1)))
  .attr("stroke-dasharray", d => dash(d.kind));

const node = g.append("g").attr("class", "node").selectAll("g").data(nodes).join("g");
node.append("circle").attr("r", 6).attr("fill", d => COLORS.cls[d.cls])
  .attr("stroke", "#0d1117").attr("stroke-width", 1.5);
node.append("text").attr("x", 9).attr("y", 3).text(d => d.label);

const sim = d3.forceSimulation(nodes)
  .force("link", d3.forceLink(links).id(d => d.id).distance(70))
  .force("charge", d3.forceManyBody().strength(-180))
  .force("center", d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2))
  .on("tick", () => {
    link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    node.attr("transform", d => \`translate(\${d.x},\${d.y})\`);
  });

node.call(d3.drag()
  .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
  .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
  .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); }));

const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const tip = document.getElementById("tip");
function show(html, ev) { tip.innerHTML = html; tip.style.display = "block"; tip.style.left = (ev.clientX + 12) + "px"; tip.style.top = (ev.clientY + 12) + "px"; }
function hide() { tip.style.display = "none"; }
node.on("mousemove", (ev, d) => {
  const refs = (d.refs || []).map(r => \`\${esc(r.path)}:\${r.line}\`).join("<br>");
  const cand = (d.candidates || []).length ? "<br><i>candidates:</i><br>" + d.candidates.map(esc).join("<br>") : "";
  show(\`<b>\${esc(d.label)}</b><br><span style="color:#8b949e">\${d.cls}</span><br>\${refs}\${cand}\`, ev);
}).on("mouseleave", hide);
link.on("mousemove", (ev, d) => show(\`\${d.kind} · <span style="color:\${COLORS.conf[d.conf]}">\${d.conf}</span>\`, ev)).on("mouseleave", hide);

const nb = new Map(nodes.map(n => [n.id, new Set([n.id])]));
edges.forEach(e => { nb.get(e.source).add(e.target); nb.get(e.target).add(e.source); });
let active = null;
node.on("click", (ev, d) => {
  ev.stopPropagation();
  active = active === d.id ? null : d.id;
  const keep = active ? nb.get(active) : null;
  node.classed("dim", n => keep && !keep.has(n.id));
  link.classed("dim", l => keep && !(keep.has(l.source.id) && keep.has(l.target.id)));
});
svg.on("click", () => { active = null; node.classed("dim", false); link.classed("dim", false); });

document.getElementById("search").addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  node.classed("dim", n => q && !n.label.toLowerCase().includes(q));
  if (q) { const hit = nodes.find(n => n.label.toLowerCase().includes(q)); if (hit && hit.x != null) {
    const t = d3.zoomIdentity.translate(window.innerWidth/2 - hit.x, window.innerHeight/2 - hit.y);
    svg.transition().duration(400).call(d3.zoom().on("zoom", ev => g.attr("transform", ev.transform)).transform, t);
  } }
});
</script>
</body></html>`;
}

// Map raw edge rows → { nodes: [...], edges: [...] }. Nodes are de-duped by id; each
// accumulates its source refs (for tooltips) and any candidate paths (ambiguous/external).
export function mapEdges(rows) {
  const nodes = new Map();
  const register = (d) => {
    let cur = nodes.get(d.id);
    if (!cur) { cur = { id: d.id, label: d.label, cls: d.cls, refs: [], candidates: [], _cand: new Set() }; nodes.set(d.id, cur); }
    if (d.ref && !cur.refs.some((r) => r.path === d.ref.path && r.line === d.ref.line)) cur.refs.push(d.ref);
    for (const c of d.candidates ?? []) if (!cur._cand.has(c)) { cur._cand.add(c); cur.candidates.push(c); }
    return cur.id;
  };
  const edges = rows.map((e) => {
    const source = register(fromNode(e));
    const target = register(toNode(e));
    return { source, target, kind: e.kind, conf: e.conf };
  });
  const out = [...nodes.values()];
  for (const n of out) delete n._cand;   // drop the transient dedup index
  return { nodes: out, edges };
}
