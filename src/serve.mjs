// src/serve.mjs — a localhost HTTP front-end for gtir's engine, powering the Obsidian
// Connections pane. Listens only; the only outbound calls are the same embedder calls `search`
// already makes (Ollama), so the zero-egress guarantee holds.
import { createServer } from "node:http";
import { openStore } from "./store.mjs";
import { computeConnections, graphNeighborhood } from "./connections.mjs";
import { search } from "./search.mjs";
import { codeLinksFor, augmentGraphWithCode } from "./crosslinks.mjs";
import { watchRepo as startWatcher } from "./watch.mjs";

const POST_ROUTES = new Set(["/connections", "/search", "/graph"]);
const GET_ROUTES = new Set(["/health"]);
const SERVE_ROUTES = [...GET_ROUTES, ...POST_ROUTES]; // advertised by /health for capability detection

// Pure routing: choose status + JSON. Enforces the optional token, method, and required args.
export async function route(handlers, { method, path, token, configuredToken, body }) {
  if (configuredToken && token !== configuredToken) return { status: 401, json: { error: "unauthorized" } };
  const isGet = GET_ROUTES.has(path), isPost = POST_ROUTES.has(path);
  if (!isGet && !isPost) return { status: 404, json: { error: `unknown route ${path}` } };
  if (isGet && method !== "GET") return { status: 405, json: { error: "method not allowed" } };
  if (isPost && method !== "POST") return { status: 405, json: { error: "method not allowed" } };
  if ((path === "/connections" || path === "/graph") && !body?.path) return { status: 400, json: { error: "path is required" } };
  if (path === "/search" && !body?.query) return { status: 400, json: { error: "query is required" } };
  try {
    return { status: 200, json: await handlers[path](body || {}) };
  } catch (e) {
    return { status: 500, json: { error: String(e && e.message || e) } };
  }
}

// Bind handlers to a config. /health reports model + dim + row count; the others delegate.
export function makeHandlers(cfg, { linkCfg = null } = {}) {
  return {
    "/health": async () => {
      const store = await openStore(cfg);
      const meta = await store.readMeta();
      const tbl = await store.chunksTable();
      // LanceDB tables expose no .countRows(); count by selecting one cheap column.
      let count = 0;
      if (tbl) {
        try {
          const rows = await tbl.query().select(["path"]).toArray();
          count = rows.length;
        } catch {
          // Fallback: full row fetch (tolerated — health is not a hot path).
          try { count = (await tbl.query().toArray()).length; } catch { count = 0; }
        }
      }
      // `routes` advertises this server's capabilities so a client can tell a current daemon from a
      // stale one (e.g. an older process that predates an endpoint) and refuse to adopt the stale one.
      // `linked` tells the plugin whether this daemon was started with a cross-corpus --link-repo, so it
      // won't adopt a non-linked daemon when the user wants note→code links.
      return { ok: true, repo: cfg.repo, model: cfg.model, dim: meta.dim ? Number(meta.dim) : null, count, routes: SERVE_ROUTES, linked: !!linkCfg };
    },
    "/connections": async (body) => {
      const res = await computeConnections(cfg, { path: body.path, k: body.k });
      if (linkCfg && body.path && !res.error && res.status !== "not-indexed") {
        try { res.code = await codeLinksFor(cfg, linkCfg, body.path); }
        catch (e) { process.stderr.write(`gtir serve: cross-links failed: ${e.message}\n`); }
      }
      return res;
    },
    "/graph": async (body) => {
      let g = await graphNeighborhood(cfg, { path: body.path, k: body.k, hops: body.hops, max: body.max });
      if (linkCfg && body.path && !g.error && Array.isArray(g.nodes) && g.nodes.length) {
        try { g = augmentGraphWithCode(g, await codeLinksFor(cfg, linkCfg, body.path)); }
        catch (e) { process.stderr.write(`gtir serve: cross-links failed: ${e.message}\n`); }
      }
      return g;
    },
    "/search": async (body) => ({ results: await search(String(body.query), cfg, { k: body.k ?? 8 }) }),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

// Start the HTTP server. Resolves once listening. host defaults to loopback.
export function startServer(cfg, { host = "127.0.0.1", port = 7411, token = null, watch = false, linkCfg = null } = {}) {
  const handlers = makeHandlers(cfg, { linkCfg });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const body = req.method === "POST" ? await readBody(req) : {};
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (body === null) return send(400, { error: "invalid json body" });
    const r = await route(handlers, {
      method: req.method, path: url.pathname,
      token: req.headers["x-gtir-token"] || null, configuredToken: token, body,
    });
    send(r.status, r.json);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      process.stderr.write(`gtir serve: http://${host}:${server.address().port} (repo ${cfg.repo})\n`);
      if (watch) {
        const w = startWatch(cfg);
        const shutdown = () => {
          try { if (w && typeof w.close === "function") w.close(); } catch { /* ignore */ }
          server.close(() => process.exit(0));
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      }
      resolve(server);
    });
  });
}

// Wire the real watcher from watch.mjs. watchRepo is synchronous (returns immediately; chokidar
// fires events later), so no await is needed. A watcher failure must never crash the server.
function startWatch(cfg) {
  try { return startWatcher(cfg, {}); }
  catch (e) { process.stderr.write(`gtir serve: watch failed to start: ${e.message}\n`); return null; }
}
