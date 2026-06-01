# vendor/grammars/

Tree-sitter grammar `.wasm` that are **not** available in the `tree-sitter-wasms`
devDependency, and so can't be bundled-at-publish like the rest. Right now that's
the shader grammars:

| File | Grammar source | Size |
| --- | --- | --- |
| `tree-sitter-glsl.wasm` | [`tree-sitter-glsl@0.2.0`](https://www.npmjs.com/package/tree-sitter-glsl) | ~0.8 MB |
| `tree-sitter-hlsl.wasm` | [`tree-sitter-hlsl@0.2.0`](https://www.npmjs.com/package/tree-sitter-hlsl) | ~4.1 MB |

The `*.wasm` are **gitignored** (kept out of git history). Two ways to get them:

```bash
gtir fetch-grammars          # USERS: download the prebuilt wasm (~5 MB, no toolchain)
npm run build:shaders        # MAINTAINERS: rebuild from source (scripts/build-shader-grammars.mjs)
```

`fetch-grammars` pulls the prebuilt, checksum-pinned wasm from the gtir GitHub release —
WebAssembly is OS/CPU-independent, so one artifact works everywhere. `build:shaders` is only
needed to *regenerate* the wasm (e.g. to update a grammar version); it needs the tree-sitter
CLI (`npm i -g tree-sitter-cli`), whose first `--wasm` build auto-downloads a ~510 MB wasi-sdk
to a user cache — no Docker, no emscripten. After rebuilding, re-upload the wasm to the release
tag and bump the pinned sha in `src/fetch-grammars.mjs`.

If the wasm are absent, gtir still indexes `.hlsl`/`.glsl` files — it just falls back
to line-window chunking instead of function-aligned AST chunking. See
`src/parser.mjs` (`grammarPath`) for the resolution order and `src/languages.mjs`
for the extension → grammar map.
