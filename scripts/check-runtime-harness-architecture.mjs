import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const violations = [];

async function sourceFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (["node_modules", "dist", "__tests__", "tests"].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (path.endsWith(".ts") || path.endsWith(".tsx")) files.push(path);
    }
  }
  await visit(directory);
  return files;
}

const runtimeSource = await sourceFiles(join(root, "packages", "runtime", "src"));
const forbiddenRuntimeImports = [
  "@aaspai/db",
  "@aaspai/harness",
  "@aaspai/sessions",
  "@aaspai/company",
  "@aaspai/observability",
];
for (const file of runtimeSource) {
  const text = await readFile(file, "utf8");
  for (const dependency of forbiddenRuntimeImports) {
    if (text.includes(`"${dependency}"`) || text.includes(`'${dependency}'`)) {
      violations.push(`${file}: forbidden Runtime V2 import ${dependency}`);
    }
  }
}

const harnessSource = await sourceFiles(join(root, "packages", "harness", "src"));
for (const file of harnessSource) {
  const text = await readFile(file, "utf8");
  for (const dependency of ["@aaspai/db", "@aaspai/sessions", "@aaspai/runtime/src"])
    if (text.includes(`"${dependency}"`) || text.includes(`'${dependency}'`)) {
      violations.push(`${file}: Harness cannot depend on persistence or a runtime provider implementation`);
    }
}

const serverDriver = (await sourceFiles(join(root, "packages", "harness", "opencode", "src", "drivers", "server"))).filter(
  (file) => file.endsWith("adapter.ts") || file.endsWith("client.ts") || file.endsWith("lifecycle.ts"),
);
for (const file of serverDriver) {
  const text = await readFile(file, "utf8");
  for (const dependency of ["node:child_process", "node:fs", "node:fs/promises"]) {
    if (text.includes(`"${dependency}"`) || text.includes(`'${dependency}'`)) {
      violations.push(`${file}: OpenCode server driver must use injected runtime boundary, not ${dependency}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Runtime V2 and OpenCode server architecture boundaries passed.");
}
