import { writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Prebuilt shader-grammar wasm, published as a gtir GitHub release asset. WebAssembly is
// OS/CPU-independent, so a single artifact serves every platform — no compiler, no wasi-sdk.
// Each sha256 is pinned: a download is verified before it's trusted (these are executable
// grammar modules). To update a grammar: `npm run build:shaders`, bump RELEASE_TAG + the
// sha here, and re-upload the new wasm to that release tag.
const RELEASE_TAG = "grammars-v1";
const BASE = `https://github.com/WooFL/gtir/releases/download/${RELEASE_TAG}`;

export const GRAMMAR_ASSETS = [
  { lang: "glsl", file: "tree-sitter-glsl.wasm", sha256: "93849ee0530cac332fdaf3e382db390db74524cf40afb99fa586d72942fda408" },
  { lang: "hlsl", file: "tree-sitter-hlsl.wasm", sha256: "18bba1b7aa72daecb9322535ea7fa7c26adef20d04cfb768ff3c3296b7f693c2" },
];

export function checksum(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function vendorDir() {
  return fileURLToPath(new URL("../vendor/grammars/", import.meta.url));
}

// Download every prebuilt grammar asset, verify its checksum, and install it into
// vendor/grammars/. fetchImpl is injectable for tests. Throws on HTTP error or checksum
// mismatch — a bad download is never written into place (downloaded to a .part, renamed
// only after verification).
export async function fetchGrammars({ log = (m) => process.stderr.write(m + "\n"), fetchImpl = fetch } = {}) {
  const dir = vendorDir();
  mkdirSync(dir, { recursive: true });
  const installed = [];
  for (const a of GRAMMAR_ASSETS) {
    const url = `${BASE}/${a.file}`;
    log(`gtir: fetching ${a.file} (${RELEASE_TAG}) …`);
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = checksum(buf);
    if (got !== a.sha256) {
      throw new Error(`checksum mismatch for ${a.file}: expected ${a.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`);
    }
    const dest = join(dir, a.file);
    const tmp = `${dest}.part`;
    try {
      writeFileSync(tmp, buf);
      renameSync(tmp, dest);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    installed.push({ lang: a.lang, file: a.file, bytes: buf.length });
    log(`gtir: installed ${a.file} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
  }
  return installed;
}
