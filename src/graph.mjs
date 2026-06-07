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

// Deterministic cluster bookkeeping for the renderer: clusters ordered by node count (desc, then
// name), a per-node cluster index aligned to `nodes`, and a fixed grid of cluster centers filling
// `spaceSize`. Pure — used at render time and embedded for the browser's cosmos cluster force.
export function clusterIndex(nodes, spaceSize = 16384) {
  const counts = new Map();
  for (const n of nodes) counts.set(n.cluster, (counts.get(n.cluster) ?? 0) + 1);
  const clusters = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const idxOf = new Map(clusters.map((c, i) => [c, i]));
  const clusterOfNode = nodes.map((n) => idxOf.get(n.cluster));
  const cols = Math.max(1, Math.ceil(Math.sqrt(clusters.length)));
  const cell = Math.floor(spaceSize / (cols + 1));
  const clusterXY = clusters.map((c, i) => [((i % cols) + 0.5) * cell, (Math.floor(i / cols) + 0.5) * cell]);
  return { clusters, clusterOfNode, clusterXY, cols, cell };
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
// Categorical palette for directory clusters (no d3 — fixed hex set; wraps past 20 clusters).
const PALETTE = [
  "#58a6ff", "#bc8cff", "#3fb950", "#e3b341", "#f85149", "#39c5cf", "#db61a2", "#a371f7",
  "#7ee787", "#ff7b72", "#79c0ff", "#ffa657", "#d2a8ff", "#56d364", "#f0883e", "#1f6feb",
  "#bf4b8a", "#8ddb8c", "#cea5fb", "#ffdf5d",
];

// JSON for embedding in a <script> — escape `<` so a "</script>" inside any string can't close the tag.
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

export function renderHtml({ nodes, edges, meta = {} }, cosmosSource) {
  const data = safeJson({ nodes, edges, meta });
  const conf = safeJson(CONF_COLOR);
  const pal = safeJson(PALETTE);
  const cosmosSafe = String(cosmosSource).replace(/<\/script>/gi, "<\\/script>");
  const trunc = meta.truncated ? `dropped ${meta.dropped ?? 0}` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>gtir graph</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0d1117;color:#c9d1d9;font:12px system-ui,sans-serif}
  #cv{position:fixed;inset:0;width:100vw;height:100vh}
  #panel{position:fixed;top:8px;left:8px;z-index:10;background:#161b22e6;border:1px solid #30363d;border-radius:6px;padding:10px 12px;max-width:240px;max-height:94vh;overflow:auto}
  #panel h1{font-size:13px;margin:0 0 8px}
  #panel label{display:block;margin:2px 0}
  #search{width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:4px;padding:4px;margin-bottom:8px}
  .row{margin:6px 0}
  .sw{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;margin-right:6px}
  #legend{margin-top:8px;max-height:30vh;overflow:auto}
  #legend .lg{cursor:pointer;line-height:1.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #counts{margin-top:8px;color:#8b949e}
  #info{position:fixed;bottom:8px;left:8px;z-index:10;background:#161b22e6;border:1px solid #30363d;border-radius:6px;padding:8px 10px;max-width:340px;display:none}
  #msg{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:20;color:#f85149;font-size:16px}
  #lblcv{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:5}
  button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:3px 8px;cursor:pointer}
</style></head>
<body>
<canvas id="cv"></canvas>
<canvas id="lblcv"></canvas>
<div id="msg"></div>
<div id="panel">
  <h1>gtir graph <button id="pause">⏸ pause</button></h1>
  <input id="search" placeholder="find node…" autocomplete="off">
  <div class="row">min degree <span id="minDegV">0</span><br><input id="minDeg" type="range" min="0" max="20" value="0" style="width:100%"></div>
  <div class="row">spacing <span id="spaceV">30</span><br><input id="space" type="range" min="6" max="140" value="30" style="width:100%"></div>
  <div class="row">labels <span id="lblNV">30</span><br><input id="lblN" type="range" min="0" max="200" value="30" style="width:100%"></div>
  <label><input type="checkbox" id="isles" checked> cluster islands</label>
  <div class="row"><b>kind</b>
    <label><input type="checkbox" class="k" value="calls" checked> calls</label>
    <label><input type="checkbox" class="k" value="imports" checked> imports</label>
    <label><input type="checkbox" class="k" value="links" checked> links</label>
    <label><input type="checkbox" class="k" value="embeds" checked> embeds</label>
  </div>
  <div class="row"><b>confidence</b>
    <label><input type="checkbox" class="cf" value="resolved" checked> <span style="color:${CONF_COLOR.resolved}">resolved</span></label>
    <label><input type="checkbox" class="cf" value="ambiguous" checked> <span style="color:${CONF_COLOR.ambiguous}">ambiguous</span></label>
    <label><input type="checkbox" class="cf" value="external"> <span style="color:${CONF_COLOR.external}">external</span></label>
  </div>
  <div id="legend"></div>
  <div id="counts">${trunc}</div>
</div>
<div id="info"></div>
<script>/* cosmos (vendored) */
${cosmosSafe}
</script>
<script>
window.__GTIR_GRAPH__ = ${data};
const CONF = ${conf}, PAL = ${pal};
const { nodes: ALLN, edges: ALLE, meta } = window.__GTIR_GRAPH__;
const esc = s => String(s).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const $ = id => document.getElementById(id);

const clusters = [...new Set(ALLN.map(n => n.cluster))];
const clusterColor = new Map(clusters.map((c, i) =>
  [c, c === "external" ? CONF.external : c === "ambiguous" ? CONF.ambiguous : PAL[i % PAL.length]]));
// Size ∝ sqrt(degree) but capped so a few mega-hubs don't swallow the canvas.
ALLN.forEach(n => { n.color = clusterColor.get(n.cluster); n.size = 3 + Math.min(12, Math.sqrt(n.degree || 0)); });
ALLE.forEach(e => { e.color = CONF[e.conf] || "#666"; e.width = Math.min(4, e.count || 1); });

// Seed each node in its cluster's grid cell, sized to fill the layout space. With near-zero link
// spring (below), the GPU force preserves this grid — clusters stay as separated territories
// instead of collapsing into one ball.
const SPACE = 16384;
const cols = Math.max(1, Math.ceil(Math.sqrt(clusters.length)));
const CELL = Math.floor(SPACE / (cols + 1));
const cIdx = new Map(clusters.map((c, i) => [c, i]));
const jit = () => Math.random() * CELL * 0.5 - CELL * 0.25;
ALLN.forEach(n => { const i = cIdx.get(n.cluster); n.x = ((i % cols) + 0.5) * CELL + jit(); n.y = (Math.floor(i / cols) + 0.5) * CELL + jit(); });

function showInfo(n) {
  const refs = (n.refs || []).map(r => esc(r.path) + ":" + r.line).join("<br>");
  const cand = (n.candidates || []).length ? "<br><i>candidates:</i><br>" + n.candidates.map(esc).join("<br>") : "";
  $("info").innerHTML = "<b>" + esc(n.label) + "</b><br><span style='color:#8b949e'>" + esc(n.cluster) + " · deg " + (n.degree || 0) + "</span><br>" + refs + cand;
  $("info").style.display = "block";
}
function hideInfo() { $("info").style.display = "none"; }

// Layout forces. With tens of thousands of edges, link springs pull everything into a ball — so:
// big space, strong repulsion, long+soft links, low gravity. The spacing slider scales
// linkDistance + repulsion together at runtime via setConfig.
// Cluster-preserving forces: near-zero link spring (links stop dragging packages into one ball),
// strong repulsion (spreads within a cluster + pushes clusters apart), low gravity, low decay so
// it cools to rest near the seeded grid. The spacing slider scales repulsion + linkDistance live.
const SIM = { gravity: 0.02, repulsion: 1.6, repulsionTheta: 1.2, linkSpring: 0.05, linkDistance: 30, friction: 0.9, decay: 2500 };

const shortName = n => (n.label.includes(" · ") ? n.label.split(" · ")[0] : (n.label.split(/[\\/]/).pop() || n.label));
const hexA = (h, a) => { const n = parseInt(h.slice(1), 16); return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; };

// Hub labels (top-N by degree) — adjustable count. cosmos renders GPU points (no native text),
// so labels + cluster "islands" are drawn on a 2D canvas LAYER over the graph, redrawn every frame
// from live node positions so they stay frame-locked (no DOM drift) and read as one scene.
let LABELN = [], labelText = new Map();
function rebuildLabels(count) {
  LABELN = [...ALLN].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, count);
  labelText = new Map(LABELN.map(n => [n.id, shortName(n)]));
  if (graph) graph.trackNodePositionsByIds(LABELN.map(n => n.id));
}
let showIslands = true;
const lcv = $("lblcv"), lctx = lcv.getContext("2d");
function sizeLabelCanvas() {
  const dpr = window.devicePixelRatio || 1;
  lcv.width = window.innerWidth * dpr; lcv.height = window.innerHeight * dpr;
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
sizeLabelCanvas();
window.addEventListener("resize", sizeLabelCanvas);

// Island geometry (per-cluster centroid + radius in graph space) is recomputed every ~12 frames
// from all visible node positions; each frame we just convert the ≤N centroids to screen + draw.
let islandGeo = [], frame = 0;
function computeIslands(pos) {
  const buck = new Map();   // cluster -> { x,y sums, n, xs[], ys[] } in space coords (visible nodes only)
  ALLN.forEach(n => {
    const p = pos.get(n.id); if (!p) return;
    let a = buck.get(n.cluster);
    if (!a) { a = { x: 0, y: 0, n: 0, xs: [], ys: [] }; buck.set(n.cluster, a); }
    a.x += p[0]; a.y += p[1]; a.n++; a.xs.push(p[0]); a.ys.push(p[1]);
  });
  islandGeo = [];
  buck.forEach((a, name) => {
    if (a.n < 3) return;                                  // skip noise clusters
    const cx = a.x / a.n, cy = a.y / a.n;
    const ds = [];
    for (let i = 0; i < a.n; i++) { const dx = a.xs[i] - cx, dy = a.ys[i] - cy; ds.push(Math.sqrt(dx * dx + dy * dy)); }
    ds.sort((u, v) => u - v);
    const r = ds[Math.floor(a.n * 0.7)] * 1.25 + 10;      // robust radius (70th pct) — not the max outlier
    islandGeo.push({ cx, cy, r, name, color: clusterColor.get(name) || "#888" });
  });
}
function draw() {
  lctx.clearRect(0, 0, lcv.width, lcv.height);
  if (!graph) return;
  frame++;
  if (showIslands) {
    if (frame % 12 === 1) computeIslands(graph.getNodePositionsMap());
    lctx.textAlign = "center"; lctx.textBaseline = "middle"; lctx.font = "11px system-ui,sans-serif";
    for (const g of islandGeo) {
      // Derive the screen radius from two POSITION conversions (center, center+r) so it scales
      // exactly like the nodes at any zoom — spaceToScreenRadius drifts from spaceToScreenPosition.
      const [sx, sy] = graph.spaceToScreenPosition([g.cx, g.cy]);
      const [ex, ey] = graph.spaceToScreenPosition([g.cx + g.r, g.cy]);
      const sr = Math.hypot(ex - sx, ey - sy);
      lctx.fillStyle = hexA(g.color, 0.10); lctx.beginPath(); lctx.arc(sx, sy, sr, 0, 6.2832); lctx.fill();
      lctx.fillStyle = "rgba(230,237,243,0.22)"; lctx.fillText(g.name, sx, sy);
    }
    lctx.textAlign = "left";
  }
  if (labelText.size) {
    const lp = graph.getTrackedNodePositionsMap();
    lctx.font = "10px system-ui,sans-serif"; lctx.textBaseline = "middle";
    lctx.lineWidth = 3; lctx.strokeStyle = "rgba(0,0,0,0.85)"; lctx.fillStyle = "#e6edf3";
    labelText.forEach((txt, id) => {
      const p = lp.get(id); if (!p) return;
      const [sx, sy] = graph.spaceToScreenPosition(p);
      lctx.strokeText(txt, sx + 7, sy); lctx.fillText(txt, sx + 7, sy);
    });
  }
}

let graph = null, paused = false;
try {
  graph = new window.cosmos.Graph($("cv"), {
    spaceSize: SPACE,
    backgroundColor: "#0d1117",
    nodeColor: n => n.color,
    nodeSize: n => n.size,
    renderLinks: true,
    linkColor: l => l.color,
    linkWidth: l => l.width,
    scaleNodesOnZoom: true,
    fitViewOnInit: true,
    simulation: SIM,
    events: {
      onClick: (n) => { if (n) { graph.selectNodeById(n.id, true); showInfo(n); } else { graph.unselectNodes(); hideInfo(); } },
      onNodeMouseOver: (n) => { if (n) showInfo(n); },
    },
  });
} catch (err) {
  $("msg").style.display = "flex";
  $("msg").textContent = "WebGL is required to view this graph.";
}
// Redraw islands + labels every frame so they track nodes during sim, drag, and inertial pan/zoom.
(function loop() { draw(); requestAnimationFrame(loop); })();

function recompute() {
  const minDeg = +$("minDeg").value;
  const kinds = new Set([...document.querySelectorAll(".k:checked")].map(x => x.value));
  const confs = new Set([...document.querySelectorAll(".cf:checked")].map(x => x.value));
  const passN = ALLN.filter(n => (n.degree || 0) >= minDeg);
  const idset = new Set(passN.map(n => n.id));
  const vE = ALLE.filter(e => kinds.has(e.kind) && confs.has(e.conf) && idset.has(e.source) && idset.has(e.target));
  const used = new Set(); vE.forEach(e => { used.add(e.source); used.add(e.target); });
  const vN = passN.filter(n => used.has(n.id));
  if (graph) {
    graph.setData(vN, vE); graph.start(0.3);
    graph.trackNodePositionsByIds(LABELN.map(n => n.id));   // re-track hubs against the new data
  }
  $("counts").textContent = vN.length + " nodes · " + vE.length + " edges" + (meta && meta.truncated ? " · dropped " + meta.dropped : "");
}

const ccount = {}; ALLN.forEach(n => { ccount[n.cluster] = (ccount[n.cluster] || 0) + 1; });
const topC = Object.entries(ccount).sort((a, b) => b[1] - a[1]).slice(0, 16);
$("legend").innerHTML = topC.map(([c]) => "<div class='lg' data-c='" + esc(c) + "'><span class='sw' style='background:" + clusterColor.get(c) + "'></span>" + esc(c) + "</div>").join("");
$("legend").querySelectorAll(".lg").forEach(el => el.addEventListener("click", () => {
  const c = el.getAttribute("data-c");
  const ids = ALLN.filter(n => n.cluster === c).map(n => n.id);
  if (graph && ids.length) { graph.selectNodesByIds(ids); graph.fitViewByNodeIds(ids); }
}));

$("minDeg").max = String(Math.max(1, ...ALLN.map(n => n.degree || 0)));
$("minDeg").addEventListener("input", () => { $("minDegV").textContent = $("minDeg").value; recompute(); });
$("space").addEventListener("input", () => {
  const d = +$("space").value;
  $("spaceV").textContent = d;
  SIM.linkDistance = d; SIM.repulsion = Math.max(1.5, d / 10);
  if (graph) { graph.setConfig({ simulation: SIM }); graph.start(0.5); }
});
$("lblN").addEventListener("input", () => { $("lblNV").textContent = $("lblN").value; rebuildLabels(+$("lblN").value); });
$("isles").addEventListener("change", () => { showIslands = $("isles").checked; });
document.querySelectorAll(".k,.cf").forEach(el => el.addEventListener("change", recompute));
$("search").addEventListener("input", () => {
  const q = $("search").value.toLowerCase();
  if (!q) { if (graph) graph.unselectNodes(); hideInfo(); return; }
  const hit = ALLN.find(n => n.label.toLowerCase().includes(q));
  if (hit && graph) { graph.selectNodeById(hit.id, true); graph.fitViewByNodeIds([hit.id]); showInfo(hit); }
});
$("pause").addEventListener("click", () => {
  if (!graph) return;
  paused = !paused;
  if (paused) { graph.pause(); $("pause").textContent = "▶ resume"; } else { graph.restart(); $("pause").textContent = "⏸ pause"; }
});

rebuildLabels(30);
if (graph) recompute();
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
