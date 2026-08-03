import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirs = ["apps", "packages"];
const concurrency = 4;

async function testableWorkspaces() {
  const workspaces = [];
  for (const dir of workspaceDirs) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, dir, entry.name, "package.json");
      try {
        const pkg = JSON.parse(await readFile(path, "utf8"));
        if (pkg.scripts?.test) workspaces.push(pkg.name);
      } catch {
        // Ignore directories without a package manifest.
      }
    }
  }
  return workspaces;
}

function runWorkspace(name, databaseRoot) {
  const windows = process.platform === "win32";
  const command = windows ? process.env.ComSpec ?? "cmd.exe" : "yarn";
  const args = windows
    ? ["/d", "/s", "/c", "yarn.cmd", "workspace", name, "test"]
    : ["workspace", name, "test"];
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        AASPAI_DB: `sqlite:${join(databaseRoot, "state.db")}`,
      },
      stdio: "inherit",
    });
    child.once("error", () => resolveRun(1));
    child.once("exit", (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
  });
}

const workspaces = await testableWorkspaces();
const pending = [...workspaces];
const failures = [];

async function worker() {
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name) return;
    const databaseRoot = await mkdtemp(join(tmpdir(), "aaspai-test-"));
    try {
      if ((await runWorkspace(name, databaseRoot)) !== 0) failures.push(name);
    } finally {
      await rm(databaseRoot, { recursive: true, force: true });
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, workspaces.length) }, worker));
if (failures.length > 0) {
  console.error(`Failed workspaces: ${failures.join(", ")}`);
  process.exitCode = 1;
}
