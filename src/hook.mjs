import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "# >>> gtir refresh >>>";
const END = "# <<< gtir refresh <<<";

function hookPath(repo) { return join(repo, ".git", "hooks", "post-commit"); }

function block(repo) {
  return [MARKER,
    `gtir refresh --repo "${repo}" >/dev/null 2>&1 || true`,
    END, ""].join("\n");
}

function stripBlock(body) {
  const start = body.indexOf(MARKER);
  if (start === -1) return body;
  const end = body.indexOf(END, start);
  if (end === -1) return body.slice(0, start);
  return (body.slice(0, start) + body.slice(end + END.length)).replace(/\n{3,}/g, "\n\n");
}

export function installHook(repo) {
  const path = hookPath(repo);
  let body = existsSync(path) ? readFileSync(path, "utf8") : "#!/bin/sh\n";
  body = stripBlock(body); // ensure idempotency
  if (!body.endsWith("\n")) body += "\n";
  body += block(repo);
  writeFileSync(path, body);
  try { chmodSync(path, 0o755); } catch { /* windows: no-op */ }
}

export function removeHook(repo) {
  const path = hookPath(repo);
  if (!existsSync(path)) return;
  writeFileSync(path, stripBlock(readFileSync(path, "utf8")));
}
