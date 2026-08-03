import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageDirs = ["apps", "packages"];
const workspacePackages = new Map();

async function sourceFiles(dir) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (["node_modules", "dist", ".next", ".next-dev-3000"].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) files.push(path);
    }
  }
  await visit(dir);
  return files;
}

for (const dir of packageDirs) {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, dir, entry.name, "package.json");
    try {
      const packageJson = JSON.parse(await readFile(path, "utf8"));
      workspacePackages.set(packageJson.name, { dir: join(root, dir, entry.name), packageJson });
    } catch {
      // Ignore workspace placeholders without manifests.
    }
  }
}

const errors = [];
for (const [name, workspace] of workspacePackages) {
  const declared = new Set([
    ...Object.keys(workspace.packageJson.dependencies ?? {}),
    ...Object.keys(workspace.packageJson.devDependencies ?? {}),
    ...Object.keys(workspace.packageJson.peerDependencies ?? {}),
  ]);
  const productionDeclared = Object.keys(workspace.packageJson.dependencies ?? {});
  const files = await sourceFiles(workspace.dir);
  const productionFiles = files.filter((file) => !file.includes("__tests__") && !/\.test\.[jt]sx?$/.test(file));
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const readSource = (file) => readFile(file, "utf8").then(stripComments);
  const productionText = (await Promise.all(productionFiles.map(readSource))).join("\n");
  const allText = (await Promise.all(files.map(readSource))).join("\n");

  for (const imported of workspacePackages.keys()) {
    if (imported === name) continue;
    const used = new RegExp(`(?:from|import|require)\\s*[(]?\\s*["']${imported.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(allText);
    if (used && !declared.has(imported)) errors.push(`${name}: undeclared import ${imported}`);
  }

  for (const dependency of productionDeclared.filter((dep) => workspacePackages.has(dep))) {
    if (
      !productionText.includes(`"${dependency}"`) &&
      !productionText.includes(`'${dependency}'`) &&
      !productionText.includes(`"${dependency}/`) &&
      !productionText.includes(`'${dependency}/`)
    ) {
      errors.push(`${name}: unused production workspace dependency ${dependency}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${workspacePackages.size} workspaces for dependency hygiene.`);
}
