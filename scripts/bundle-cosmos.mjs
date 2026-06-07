// One-time vendor build: bundle @cosmograph/cosmos (+ its d3-*/regl/gl-matrix deps) into a single
// self-contained IIFE at vendor/cosmos.min.js. Run via `npm run bundle:cosmos` after `npm i`.
// NOT run at view time — the committed bundle is what `gtir graph` inlines.
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/cosmos-entry.mjs"],
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: ["es2020"],
  outfile: "vendor/cosmos.min.js",
  legalComments: "none",
});
console.log("bundled → vendor/cosmos.min.js");
