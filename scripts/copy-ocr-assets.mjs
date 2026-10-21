// Copia worker, núcleo WASM y modelo de español de Tesseract a /public/tesseract
// para que el OCR funcione sin internet.
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const out = join(process.cwd(), "public", "tesseract");

mkdirSync(join(out, "core"), { recursive: true });
mkdirSync(join(out, "lang"), { recursive: true });

cpSync(join(pkgDir("tesseract.js"), "dist", "worker.min.js"), join(out, "worker.min.js"));
const core = pkgDir("tesseract.js-core");
for (const f of [
  "tesseract-core.wasm.js", "tesseract-core-simd.wasm.js",
  "tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-relaxedsimd.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js",
]) {
  const src = join(core, f);
  if (existsSync(src)) cpSync(src, join(out, "core", f));
}
cpSync(join(pkgDir("@tesseract.js-data/spa"), "4.0.0_best_int", "spa.traineddata.gz"),
       join(out, "lang", "spa.traineddata.gz"));
console.log("OCR offline listo en public/tesseract");
