/**
 * Build script for the aaspai CLI.
 *
 * Uses esbuild to bundle `src/cli.ts` together with every
 * `@aaspai/*` workspace dep (and their transitive deps) into
 * a single self-contained `dist/aaspai.js`. The result has
 * the shebang prepended, is marked as an ES module, and bundles
 * better-sqlite3 as an external (native bindings, can't be bundled).
 */
import { build } from "esbuild";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "dist");
const outFile = join(outDir, "aaspai.js");

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// Native modules can't be bundled. Mark them as external so they're
// required at runtime from node_modules.
const external = [
  "better-sqlite3",
  "bindings",
  // Native or peer-dep modules
  "esbuild", // shouldn't be in our graph but be safe
];

await build({
  entryPoints: [join(__dirname, "src/cli.ts")],
  bundle: true,
  outfile: outFile,
  platform: "node",
  target: "node20",
  // CJS format so the bundled CJS deps (commander, etc.) can use
  // require(). ESM bundles have to mark all CJS deps as external
  // or get the "Dynamic require is not supported" error.
  format: "cjs",
  // The shebang from src/cli.ts is preserved automatically by esbuild
  // for CJS entry points.
  external,
  minify: false,
  sourcemap: true,
  loader: {
    ".ts": "ts",
    ".tsx": "tsx",
  },
  logLevel: "info",
  metafile: true,
  treeShaking: true,
});

// Make the file executable on POSIX systems (no-op on Windows)
try {
  const { chmod } = await import("node:fs/promises");
  await chmod(outFile, 0o755);
} catch { /* best effort on Windows */ }

console.log(`✓ Built ${outFile}`);
try {
  const metaPath = join(outDir, "aaspai.js.meta.json");
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const totalBytes = Object.values(meta.outputs).reduce((s, o) => s + (o.bytes ?? 0), 0);
    console.log(`  size: ${(totalBytes / 1024).toFixed(1)} KB`);
  }
} catch { /* size reporting is best-effort */ }
