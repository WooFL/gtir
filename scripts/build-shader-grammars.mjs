#!/usr/bin/env node
// Build the shader grammar wasm (GLSL, HLSL) that gtir loads from vendor/grammars/.
//
// Who runs this: MAINTAINERS regenerating the grammars (e.g. to bump a grammar version).
// END USERS should run `gtir fetch-grammars` instead — it downloads these same wasm,
// prebuilt and checksum-pinned, from the GitHub release (no toolchain needed).
//
// Why it exists: these two grammars are NOT in the tree-sitter-wasms devDependency, so they
// can't be bundled-at-publish like the others. They're kept out of git (vendor/grammars/*.wasm
// is gitignored — ~5MB of binaries) and rebuilt from source here. After rebuilding, re-upload
// the wasm to the release tag and bump the pinned sha256 in src/fetch-grammars.mjs.
//
// Requirements:
//   - tree-sitter CLI >= 0.25 on PATH:   npm i -g tree-sitter-cli
//     (the first --wasm build auto-downloads a ~510MB wasi-sdk to a user cache;
//      no Docker and no emscripten needed)
//   - network access to npm (to fetch the grammar sources)
//
// Usage:  node scripts/build-shader-grammars.mjs      (or: npm run build:shaders)

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned grammar sources (published on npm). Bump the version here to update a grammar.
const GRAMMARS = [
  { lang: "glsl", pkg: "tree-sitter-glsl", version: "0.2.0" },
  { lang: "hlsl", pkg: "tree-sitter-hlsl", version: "0.2.0" },
];

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "vendor", "grammars");
const onWin = process.platform === "win32"; // npm / tree-sitter are .cmd shims on Windows

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: onWin });
}

// 1) The tree-sitter CLI is the only hard prerequisite.
try {
  console.log(`tree-sitter CLI: ${run("tree-sitter", ["--version"]).trim()}`);
} catch {
  console.error("ERROR: tree-sitter CLI not found on PATH.");
  console.error("  Install it with:  npm i -g tree-sitter-cli");
  console.error("  (the first --wasm build auto-downloads a ~510MB wasi-sdk to a user cache; no Docker needed)");
  process.exitCode = 1;
  throw new Error("missing tree-sitter CLI");
}

mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "gtir-shader-build-"));
try {
  for (const { lang, pkg, version } of GRAMMARS) {
    console.log(`\n=== ${pkg}@${version} ===`);
    // 2) Fetch the grammar source tarball from npm.
    run("npm", ["pack", `${pkg}@${version}`, "--pack-destination", work], work);
    const tgz = readdirSync(work).find((f) => f.startsWith(pkg) && f.endsWith(".tgz"));
    if (!tgz) throw new Error(`npm pack produced no tarball for ${pkg}`);
    // 3) Extract it (the npm tarball wraps everything in a package/ dir; strip it).
    const srcDir = join(work, lang);
    mkdirSync(srcDir, { recursive: true });
    run("tar", ["-xzf", join(work, tgz), "-C", srcDir, "--strip-components=1"]);
    // 4) Build the wasm. Output name comes from grammar.js (tree-sitter-<lang>.wasm).
    run("tree-sitter", ["build", "--wasm"], srcDir);
    const wasm = readdirSync(srcDir).find((f) => f.endsWith(".wasm"));
    if (!wasm) throw new Error(`tree-sitter build produced no wasm for ${pkg}`);
    // 5) Vendor it under the canonical name gtir's loader resolves.
    const dest = join(outDir, `tree-sitter-${lang}.wasm`);
    copyFileSync(join(srcDir, wasm), dest);
    console.log(`  built → vendor/grammars/tree-sitter-${lang}.wasm  (${(statSync(dest).size / 1024 / 1024).toFixed(1)}MB)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\nDone. Vendored ${GRAMMARS.length} shader grammars into vendor/grammars/.`);
