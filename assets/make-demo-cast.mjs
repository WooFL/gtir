// Generate assets/demo.cast (asciicast v2) from the REAL `gtir demo` output.
// The cast replays the exact bytes the command prints; only the keystroke/line timing is
// scripted (a live TTY capture isn't always available in CI). To re-record live instead:
//   asciinema rec -c "gtir demo" assets/demo.cast
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Real output, ANSI on. Warm the index first so the cast shows the instant path, not the one-time build.
execSync("node bin/gtir.mjs demo --no-color", { cwd: root, stdio: "ignore" });
const raw = execSync("node bin/gtir.mjs demo --color", { cwd: root, encoding: "utf8" });

const header = {
  version: 2, width: 84, height: 26, timestamp: Math.floor(Date.now() / 1000),
  title: "gtir demo", env: { SHELL: "/bin/bash", TERM: "xterm-256color" },
};

const events = [];
let t = 0;
const at = (dt, data) => { t += dt; events.push([Number(t.toFixed(3)), "o", data]); };

at(0.5, "\x1b[1;32m$\x1b[0m ");                 // prompt
for (const ch of "gtir demo") at(0.07, ch);     // typed command
at(0.45, "\r\n");                               // enter
for (const line of raw.replace(/\r?\n$/, "").split("\n")) at(0.12, line + "\r\n"); // stream output
at(2.5, "");                                    // hold the final frame

const cast = [header, ...events].map((x) => JSON.stringify(x)).join("\n") + "\n";
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "assets", "demo.cast"), cast);
console.log(`wrote assets/demo.cast — ${events.length} events, ~${t.toFixed(1)}s`);
