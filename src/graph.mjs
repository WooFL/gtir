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

// TO-side node descriptor. Resolved/inferred → real target; non-resolved → named synthetic node
// keyed by ref_name (degrading to a shared "" sink when ref_name is null, i.e. a stale index).
function toNode(e) {
  if (e.conf === "resolved" || e.conf === "inferred") {
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
  // dispatch: a confirmed multi-implementer set (to_path is null) — render like ambiguous, as a named
  // synthetic node carrying its candidate implementer paths, but with its own class/color.
  if (e.conf === "dispatch") {
    return { id: `disp:${name}`, label: name || "(dispatch)", cls: "dispatch", ref: null, candidates: e.candidates };
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
  if (id.startsWith("disp:")) return id.slice(5);
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
// dominates; external (correctly outside the index) next; inferred sits just above resolved; resolved is the baseline.
const SEVERITY = { resolved: 0, inferred: 1, dispatch: 2, external: 3, ambiguous: 4 };
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
  if (id.startsWith("disp:")) return "dispatch";
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

const CONF_COLOR = { resolved: "#3fb950", inferred: "#39c5cf", dispatch: "#a371f7", ambiguous: "#d29922", external: "#8b949e" };
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
  const ci = clusterIndex(nodes);
  const data = safeJson({ nodes, edges, meta, ci });
  const conf = safeJson(CONF_COLOR);
  const pal = safeJson(PALETTE);
  const cosmosSafe = String(cosmosSource).replace(/<\/script>/gi, "<\\/script>");
  const trunc = meta.truncated ? `dropped ${meta.dropped ?? 0}` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>gtir graph</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0d1117;color:#c9d1d9;font:12px system-ui,sans-serif}
  #cv{position:fixed;inset:0;width:100vw;height:100vh}
  #lblcv{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:5}
  #panel{position:fixed;top:8px;left:8px;z-index:10;background:#161b22e6;border:1px solid #30363d;border-radius:6px;padding:10px 12px;max-width:240px;max-height:94vh;overflow:auto}
  #panel h1{font-size:13px;margin:0 0 8px}
  #panel label{display:block;margin:2px 0}
  #search{width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:4px;padding:4px;margin-bottom:8px}
  .row{margin:6px 0}
  .sw{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;margin-right:6px}
  #legend{margin-top:8px;max-height:30vh;overflow:auto}
  #legend .lg{cursor:pointer;line-height:1.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #counts{margin-top:8px;color:#8b949e}
  #info{position:fixed;bottom:8px;right:8px;z-index:10;background:#161b22e6;border:1px solid #30363d;border-radius:6px;padding:8px 10px;max-width:340px;max-height:60vh;overflow:auto;display:none}
  #msg{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:20;color:#f85149;font-size:16px}
  #tip{position:fixed;z-index:15;pointer-events:none;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:3px 7px;font-size:11px;display:none;white-space:nowrap}
  button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:3px 8px;cursor:pointer}
</style></head>
<body>
<div id="cv"></div>
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
    <label><input type="checkbox" class="cf" value="inferred" checked> <span style="color:${CONF_COLOR.inferred}">inferred</span></label>
    <label><input type="checkbox" class="cf" value="dispatch" checked> <span style="color:${CONF_COLOR.dispatch}">dispatch</span></label>
    <label><input type="checkbox" class="cf" value="ambiguous" checked> <span style="color:${CONF_COLOR.ambiguous}">ambiguous</span></label>
    <label><input type="checkbox" class="cf" value="external"> <span style="color:${CONF_COLOR.external}">external</span></label>
  </div>
  <div id="legend"></div>
  <div id="counts">${trunc}</div>
</div>
<div id="info"></div>
<div id="tip"></div>
<script>/* cosmos (vendored) */
${cosmosSafe}
</script>
<script>
window.__GTIR_GRAPH__ = ${data};
const CONF = ${conf}, PAL = ${pal};
const { nodes: NODES, edges: EDGES, meta, ci } = window.__GTIR_GRAPH__;
const { clusters, clusterOfNode, clusterXY, cell } = ci;
const esc = s => String(s).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const $ = id => document.getElementById(id);
const hexRGB = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hexA = (h, a) => { const c = hexRGB(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; };
const shortName = n => (n.label.includes(" · ") ? n.label.split(" · ")[0] : (n.label.split(/[\\/]/).pop() || n.label));

const clusterHex = clusters.map((c, i) => c === "external" ? CONF.external : c === "ambiguous" ? CONF.ambiguous : c === "dispatch" ? CONF.dispatch : PAL[i % PAL.length]);
const clusterRGB = clusterHex.map(hexRGB);
const confRGB = { resolved: hexRGB(CONF.resolved), inferred: hexRGB(CONF.inferred), dispatch: hexRGB(CONF.dispatch), ambiguous: hexRGB(CONF.ambiguous), external: hexRGB(CONF.external) };
const clusterPosFlat = []; clusterXY.forEach(p => { clusterPosFlat.push(p[0], p[1]); });

const idToIdx = new Map(NODES.map((n, i) => [n.id, i]));
NODES.forEach(n => { n._size = 3 + Math.min(12, Math.sqrt(n.degree || 0)); });

const lcv = $("lblcv"), lctx = lcv.getContext("2d");
function sizeLabelCanvas() { const dpr = window.devicePixelRatio || 1; lcv.width = innerWidth * dpr; lcv.height = innerHeight * dpr; lctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
sizeLabelCanvas(); addEventListener("resize", sizeLabelCanvas);

function showInfo(n) {
  const all = n.refs || [], shown = all.slice(0, 8);
  let refs = shown.map(r => esc(r.path) + ":" + r.line).join("<br>");
  if (all.length > shown.length) refs += "<br><span style='color:#8b949e'>…" + (all.length - shown.length) + " more</span>";
  const cand = (n.candidates || []).length ? "<br><i>candidates:</i><br>" + n.candidates.slice(0, 8).map(esc).join("<br>") : "";
  $("info").innerHTML = "<b>" + esc(n.label) + "</b><br><span style='color:#8b949e'>" + esc(n.cluster) + " · deg " + (n.degree || 0) + "</span><br>" + refs + cand;
  $("info").style.display = "block";
}
function hideInfo() { $("info").style.display = "none"; }

let graph = null, paused = false, spread = 1;
let curVisIdx = [], curLocal = new Int32Array(NODES.length).fill(-1);
let labelMap = new Map(), showIslands = true, islandR = new Map(), frame = 0;

try {
  graph = new window.cosmos.Graph($("cv"), {
    spaceSize: 16384,
    backgroundColor: "#0d1117",
    disableSimulation: true,        // deterministic placement — we position every point ourselves
    scalePointsOnZoom: true,
    renderHoveredPointRing: true,
    hoveredPointRingColor: "#e6edf3",
    hoveredPointCursor: "pointer",
    onClick: (index) => {
      if (index != null) { graph.selectPointByIndex(index, true); const n = NODES[curVisIdx[index]]; if (n) showInfo(n); }
      else { graph.unselectPoints(); hideInfo(); }
    },
    onPointMouseOver: (index, pos, event) => {
      const n = NODES[curVisIdx[index]]; if (!n) return;
      const t = $("tip"); t.textContent = shortName(n); t.style.display = "block";
      if (event && event.clientX != null) { t.style.left = (event.clientX + 12) + "px"; t.style.top = (event.clientY + 12) + "px"; }
    },
    onPointMouseOut: () => { $("tip").style.display = "none"; },
  });
  window.gtirGraph = graph;   // expose for power users / debugging
} catch (err) {
  $("msg").style.display = "flex";
  $("msg").textContent = "WebGL is required to view this graph.";
}

function rebuildLabelMap(count) {
  labelMap = new Map();
  const order = [...curVisIdx].sort((a, b) => (NODES[b].degree || 0) - (NODES[a].degree || 0)).slice(0, count);
  for (const gi of order) { const li = curLocal[gi]; if (li >= 0) labelMap.set(li, shortName(NODES[gi])); }
  if (graph) graph.trackPointPositionsByIndices([...labelMap.keys()]);
}

function recompute() {
  const minDeg = +$("minDeg").value;
  const kinds = new Set([...document.querySelectorAll(".k:checked")].map(x => x.value));
  const confs = new Set([...document.querySelectorAll(".cf:checked")].map(x => x.value));
  const pass = new Uint8Array(NODES.length);
  for (let i = 0; i < NODES.length; i++) pass[i] = (NODES[i].degree || 0) >= minDeg ? 1 : 0;
  const vE = [];
  for (const e of EDGES) {
    if (!kinds.has(e.kind) || !confs.has(e.conf)) continue;
    const s = idToIdx.get(e.source), t = idToIdx.get(e.target);
    if (s == null || t == null || !pass[s] || !pass[t]) continue;
    vE.push([s, t, e]);
  }
  const used = new Uint8Array(NODES.length); for (const x of vE) { used[x[0]] = 1; used[x[1]] = 1; }
  const local = new Int32Array(NODES.length).fill(-1); const visIdx = [];
  for (let i = 0; i < NODES.length; i++) if (used[i]) { local[i] = visIdx.length; visIdx.push(i); }
  const N = visIdx.length, L = vE.length;
  const pos = new Float32Array(N * 2), col = new Float32Array(N * 4), siz = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const i = visIdx[k], rgb = clusterRGB[clusterOfNode[i]];
    col[k * 4] = rgb[0]; col[k * 4 + 1] = rgb[1]; col[k * 4 + 2] = rgb[2]; col[k * 4 + 3] = 1;
    siz[k] = NODES[i]._size;
  }
  // Deterministic placement: pack each cluster's visible nodes into a disc at its grid cell, hubs
  // at the center (sunflower spiral). No simulation runs — positions ARE these, so territories are
  // clean by construction and the islands (cell center + disc radius) align exactly.
  const byCluster = new Map();
  for (let k = 0; k < N; k++) { const cc = clusterOfNode[visIdx[k]]; let a = byCluster.get(cc); if (!a) { a = []; byCluster.set(cc, a); } a.push(k); }
  islandR = new Map();
  const GA = 2.399963229728653;
  byCluster.forEach((ks, cc) => {
    ks.sort((p, q) => (NODES[visIdx[q]].degree || 0) - (NODES[visIdx[p]].degree || 0));
    const cnt = ks.length, xy = clusterXY[cc];
    const R = Math.min(cell * 0.42, 30 + Math.sqrt(cnt) * cell * 0.02) * spread;
    for (let j = 0; j < cnt; j++) {
      const k = ks[j], rr = R * Math.sqrt((j + 0.5) / cnt), th = j * GA;
      pos[k * 2] = xy[0] + rr * Math.cos(th); pos[k * 2 + 1] = xy[1] + rr * Math.sin(th);
    }
    islandR.set(cc, R + 14);
  });
  const lnk = new Float32Array(L * 2), lcol = new Float32Array(L * 4), lwid = new Float32Array(L);
  for (let k = 0; k < L; k++) {
    const s = vE[k][0], t = vE[k][1], e = vE[k][2], rgb = confRGB[e.conf] || [120, 120, 120];
    const intra = clusterOfNode[s] === clusterOfNode[t];
    lnk[k * 2] = local[s]; lnk[k * 2 + 1] = local[t];
    lcol[k * 4] = rgb[0]; lcol[k * 4 + 1] = rgb[1]; lcol[k * 4 + 2] = rgb[2]; lcol[k * 4 + 3] = intra ? 0.7 : 0.12;
    lwid[k] = intra ? Math.min(4, e.count || 1) : 0.5;
  }
  if (graph) {
    graph.setPointPositions(pos); graph.setPointColors(col); graph.setPointSizes(siz);
    graph.setLinks(lnk); graph.setLinkColors(lcol); graph.setLinkWidths(lwid);
    graph.render(0.1);
  }
  curVisIdx = visIdx; curLocal = local;
  rebuildLabelMap(+$("lblN").value);
  $("counts").textContent = N + " nodes · " + L + " edges" + (meta && meta.truncated ? " · dropped " + meta.dropped : "");
}

function draw() {
  lctx.clearRect(0, 0, lcv.width, lcv.height);
  if (!graph) return;
  frame++;
  if (showIslands) {
    lctx.textAlign = "center"; lctx.textBaseline = "bottom"; lctx.font = "600 12px system-ui,sans-serif";
    islandR.forEach((r, cc) => {
      const c = clusterXY[cc];
      const a = graph.spaceToScreenPosition([c[0], c[1]]);
      const b = graph.spaceToScreenPosition([c[0] + r, c[1]]);
      const sr = Math.hypot(b[0] - a[0], b[1] - a[1]);
      lctx.fillStyle = hexA(clusterHex[cc], 0.10); lctx.beginPath(); lctx.arc(a[0], a[1], sr, 0, 6.2832); lctx.fill();
      // name on top of the circle
      const ty = a[1] - sr - 4;
      lctx.lineWidth = 3; lctx.strokeStyle = "rgba(0,0,0,0.8)"; lctx.strokeText(clusters[cc], a[0], ty);
      lctx.fillStyle = hexA(clusterHex[cc], 0.95); lctx.fillText(clusters[cc], a[0], ty);
    });
    lctx.textAlign = "left"; lctx.textBaseline = "middle";
  }
  if (labelMap.size) {
    const lp = graph.getTrackedPointPositionsMap();
    lctx.font = "10px system-ui,sans-serif"; lctx.textBaseline = "middle";
    lctx.lineWidth = 3; lctx.strokeStyle = "rgba(0,0,0,0.85)"; lctx.fillStyle = "#e6edf3";
    labelMap.forEach((txt, li) => {
      const p = lp.get(li); if (!p) return;
      const s = graph.spaceToScreenPosition(p);
      lctx.strokeText(txt, s[0] + 7, s[1]); lctx.fillText(txt, s[0] + 7, s[1]);
    });
  }
}
(function loop() { draw(); requestAnimationFrame(loop); })();

const ccount = {}; NODES.forEach(n => { ccount[n.cluster] = (ccount[n.cluster] || 0) + 1; });
const topC = Object.entries(ccount).sort((a, b) => b[1] - a[1]).slice(0, 16);
$("legend").innerHTML = topC.map(([c]) => "<div class='lg' data-c='" + esc(c) + "'><span class='sw' style='background:" + clusterHex[clusters.indexOf(c)] + "'></span>" + esc(c) + "</div>").join("");
$("legend").querySelectorAll(".lg").forEach(el => el.addEventListener("click", () => {
  const c = el.getAttribute("data-c"); const idxs = [];
  for (let li = 0; li < curVisIdx.length; li++) if (NODES[curVisIdx[li]].cluster === c) idxs.push(li);
  if (graph && idxs.length) graph.selectPointsByIndices(idxs);
}));

$("minDeg").max = String(Math.max(1, ...NODES.map(n => n.degree || 0)));
$("minDeg").addEventListener("input", () => { $("minDegV").textContent = $("minDeg").value; recompute(); });
$("lblN").addEventListener("input", () => { $("lblNV").textContent = $("lblN").value; rebuildLabelMap(+$("lblN").value); });
$("isles").addEventListener("change", () => { showIslands = $("isles").checked; });
$("space").addEventListener("input", () => {
  const d = +$("space").value; $("spaceV").textContent = d;
  spread = Math.max(0.2, d / 30);   // scales each cluster's disc radius; re-pack
  recompute();
});
document.querySelectorAll(".k,.cf").forEach(el => el.addEventListener("change", recompute));
$("search").addEventListener("input", () => {
  const q = $("search").value.toLowerCase();
  if (!q) { if (graph) graph.unselectPoints(); hideInfo(); return; }
  const gi = NODES.findIndex(n => n.label.toLowerCase().includes(q));
  if (gi >= 0) { const li = curLocal[gi]; if (li >= 0 && graph) { graph.selectPointByIndex(li, true); graph.zoomToPointByIndex(li); showInfo(NODES[gi]); } }
});
$("pause").addEventListener("click", () => {
  if (!graph) return; paused = !paused;
  if (paused) { graph.pause(); $("pause").textContent = "▶ resume"; } else { graph.restart(); $("pause").textContent = "⏸ pause"; }
});

function fitAll(ms) { if (graph && curVisIdx.length) graph.fitViewByPointIndices(curVisIdx.map((_, i) => i), ms); }
if (graph) { recompute(); setTimeout(() => fitAll(0), 100); setTimeout(() => fitAll(400), 700); }
</script>
</body></html>`;
}

// Escape a node label for use inside a Mermaid double-quoted label: replace " with #quot;,
// strip newlines, and truncate to ~60 chars with an ellipsis.
function escapeMermaidLabel(raw) {
  let s = String(raw ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, "#quot;");
  if (s.length > 62) s = s.slice(0, 61) + "…";
  return s;
}

// Pure Mermaid flowchart renderer. Takes the same { nodes, edges, meta } shape that
// renderHtml receives (i.e. nodes from buildGraph — with .id/.label/.cls/.degree/.cluster
// and edges with .source/.target/.kind/.conf). Returns a string.
//
// - IDs are always n<index> (never raw node ids) so they are Mermaid-safe identifiers.
// - Labels are double-quoted and " is escaped as #quot;.
// - Edges are sorted by [sourceIdx, targetIdx, kind] for deterministic output.
// - Empty graph → valid flowchart with a %% no edges comment (does not throw).
// - meta.truncated → prepends a %% capped to N nodes comment.
export function renderMermaid({ nodes, edges, meta = {} } = {}) {
  const ns = nodes ?? [];
  const es = edges ?? [];

  // Build a stable node-id → index map (insertion order = the order nodes arrive).
  const nodeIdx = new Map(ns.map((n, i) => [n.id, i]));

  const lines = ["flowchart LR"];

  // Optional cap comment.
  if (meta && meta.truncated) {
    lines.push(`%% capped to ${ns.length} nodes (dropped ${meta.dropped ?? 0})`);
  }

  // Node declarations: n<i>["<escaped-label>"]
  for (let i = 0; i < ns.length; i++) {
    lines.push(`  n${i}["${escapeMermaidLabel(ns[i].label)}"]`);
  }

  // Edge declarations: sorted for determinism.
  if (es.length === 0) {
    lines.push("  %% no edges");
  } else {
    const sorted = [...es].sort((a, b) => {
      const ai = nodeIdx.get(a.source) ?? 0, bi = nodeIdx.get(b.source) ?? 0;
      if (ai !== bi) return ai - bi;
      const at = nodeIdx.get(a.target) ?? 0, bt = nodeIdx.get(b.target) ?? 0;
      if (at !== bt) return at - bt;
      return (a.kind ?? "") < (b.kind ?? "") ? -1 : (a.kind ?? "") > (b.kind ?? "") ? 1 : 0;
    });
    for (const e of sorted) {
      const si = nodeIdx.get(e.source);
      const ti = nodeIdx.get(e.target);
      if (si === undefined || ti === undefined) continue; // edge refers to unknown node — skip
      lines.push(`  n${si} -->|${e.kind || "edge"}| n${ti}`);
    }
  }

  return lines.join("\n");
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
