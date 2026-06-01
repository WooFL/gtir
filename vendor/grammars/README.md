# vendor/grammars/

Tree-sitter grammar `.wasm` that are **not** available in the `tree-sitter-wasms`
devDependency, and so can't be bundled-at-publish like the rest. Right now that's
the shader grammars:

| File | Grammar source | Size |
| --- | --- | --- |
| `tree-sitter-glsl.wasm` | [`tree-sitter-glsl@0.2.0`](https://www.npmjs.com/package/tree-sitter-glsl) | ~0.8 MB |
| `tree-sitter-hlsl.wasm` | [`tree-sitter-hlsl@0.2.0`](https://www.npmjs.com/package/tree-sitter-hlsl) | ~4.1 MB |

The `*.wasm` are **gitignored** (kept out of git history) and regenerated from source:

```bash
npm run build:shaders        # node scripts/build-shader-grammars.mjs
```

That needs the tree-sitter CLI (`npm i -g tree-sitter-cli`); its first `--wasm` build
auto-downloads a ~510 MB wasi-sdk to a user cache — no Docker, no emscripten.

If the wasm are absent, gtir still indexes `.hlsl`/`.glsl` files — it just falls back
to line-window chunking instead of function-aligned AST chunking. See
`src/parser.mjs` (`grammarPath`) for the resolution order and `src/languages.mjs`
for the extension → grammar map.
