import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/serve.mjs";

const handlers = {
  "/health": async () => ({ ok: true, repo: "r", model: "m", dim: 16, count: 3 }),
  "/connections": async (body) => ({ note: body.path, results: [] }),
  "/search": async (body) => ({ results: [{ path: "a.md", query: body.query }] }),
};

test("route: GET /health returns 200 and the health json", async () => {
  const r = await route(handlers, { method: "GET", path: "/health", token: null, configuredToken: null, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("route: POST /connections requires a path", async () => {
  const ok = await route(handlers, { method: "POST", path: "/connections", token: null, configuredToken: null, body: { path: "a.md" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.note, "a.md");
  const bad = await route(handlers, { method: "POST", path: "/connections", token: null, configuredToken: null, body: {} });
  assert.equal(bad.status, 400);
});

test("route: unknown path is 404, wrong method is 405", async () => {
  assert.equal((await route(handlers, { method: "GET", path: "/nope", token: null, configuredToken: null, body: {} })).status, 404);
  assert.equal((await route(handlers, { method: "GET", path: "/connections", token: null, configuredToken: null, body: {} })).status, 405);
});

test("route: a configured token is enforced", async () => {
  const denied = await route(handlers, { method: "GET", path: "/health", token: "wrong", configuredToken: "secret", body: {} });
  assert.equal(denied.status, 401);
  const ok = await route(handlers, { method: "GET", path: "/health", token: "secret", configuredToken: "secret", body: {} });
  assert.equal(ok.status, 200);
});

test("route: a handler that throws becomes 500 with an error field", async () => {
  const boom = { "/health": async () => { throw new Error("ollama down"); } };
  const r = await route(boom, { method: "GET", path: "/health", token: null, configuredToken: null, body: {} });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /ollama down/);
});
