/**
 * aaspai-worker CLI — start / stop / status / logs.
 *
 * Single-file CLI for the worker daemon. No command framework — the
 * surface is small enough to be a few if-statements.
 *
 * Run:
 *   aaspai-worker start
 *   aaspai-worker start --daemon
 *   aaspai-worker stop
 *   aaspai-worker status
 *   aaspai-worker logs [--tail N]
 *
 * Env:
 *   AASPAI_AGENTS_DIR    (default: ./agents)
 *   AASPAI_KNOWLEDGE_DIR (default: ./knowledge)
 *   AASPAI_LOOPS_DIR     (default: ./loops)
 *   AASPAI_TICK_INTERVAL_MS (default: 60000)
 *   AASPAI_WAKEUP_POLL_INTERVAL_MS (default: 5000)
 */
import { writeFile, readFile, unlink, mkdir, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { WorkerDaemon } from "./daemon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const PID_FILE = ".aaspai/worker.pid";
const LOG_FILE = ".aaspai/worker.log";

function usage(): never {
  console.log(`aaspai-worker — the long-lived loop daemon

Usage:
  aaspai-worker start [--daemon]
  aaspai-worker stop
  aaspai-worker status
  aaspai-worker logs [--tail N]
`);
  process.exit(1);
}

async function readPid(): Promise<number | null> {
  if (!existsSync(PID_FILE)) return null;
  const raw = await readFile(PID_FILE, "utf8");
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdStart(args: string[]): Promise<void> {
  const daemon = args.includes("--daemon");
  const existing = await readPid();
  if (existing !== null && isRunning(existing)) {
    console.error(`worker is already running (pid ${existing})`);
    process.exit(1);
  }

  if (daemon) {
    await mkdir(dirname(LOG_FILE), { recursive: true });
    const logFd = await open(LOG_FILE, "a");
    // Resolve tsx's loader.mjs via the parent's module resolution. Yarn
    // workspaces hoist to the repo root, so this works even from the
    // user's CWD. On Windows, --import needs a proper file:// URL.
    const tsxLoaderPath = _require.resolve("tsx");
    const tsxSpecifier = process.platform === "win32"
      ? pathToFileURL(tsxLoaderPath).href
      : tsxLoaderPath;
    const child = spawn(
      process.execPath,
      [
        "--import",
        tsxSpecifier,
        resolve(__dirname, "main.ts"),
        "start",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", logFd.fd, logFd.fd],
        detached: true,
      },
    );
    child.unref();
    await logFd.close();
    // Note: do NOT write the PID file here. The child writes its own
    // PID after it confirms it's running. That avoids a race where the
    // parent writes the PID and exits before the child is alive.
    if (child.pid === undefined) {
      throw new Error("failed to spawn background worker (no pid)");
    }
    console.log(`aaspai-worker started (pid ${child.pid}, logs: ${LOG_FILE})`);
    return;
  }

  // Foreground mode
  const worker = new WorkerDaemon();
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await worker.stop();
    try { await unlink(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await worker.start();
  // Write the PID file AFTER the worker is running so a race in the
  // parent (which spawned us) doesn't see a stale file.
  await writeFile(PID_FILE, String(process.pid), "utf8");
  console.log(`aaspai-worker running (pid ${process.pid}). Press Ctrl+C to stop.`);
  await new Promise(() => {});
}

async function cmdStop(): Promise<void> {
  const pid = await readPid();
  if (pid === null) {
    console.log("worker is not running");
    return;
  }
  if (!isRunning(pid)) {
    console.log("worker pid file is stale; cleaning up");
    try { await unlink(PID_FILE); } catch { /* ignore */ }
    return;
  }
  console.log(`stopping worker (pid ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 100; i++) {
      if (!isRunning(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isRunning(pid)) {
      console.log("worker did not exit gracefully; sending SIGKILL");
      process.kill(pid, "SIGKILL");
    }
  } catch (err) {
    console.error(`failed to kill pid ${pid}: ${(err as Error).message}`);
  }
  try { await unlink(PID_FILE); } catch { /* ignore */ }
  console.log("worker stopped");
}

async function cmdStatus(): Promise<void> {
  const pid = await readPid();
  if (pid === null || !isRunning(pid)) {
    console.log("worker is not running");
    return;
  }
  console.log(`worker is running (pid ${pid})`);
  if (existsSync(LOG_FILE)) {
    const stat = await import("node:fs/promises").then((m) => m.stat(LOG_FILE));
    console.log(`log file: ${LOG_FILE} (${(stat.size / 1024).toFixed(1)} KB)`);
  }
}

async function cmdLogs(args: string[]): Promise<void> {
  const tailIdx = args.indexOf("--tail");
  const n = tailIdx >= 0 ? Number(args[tailIdx + 1] ?? "20") : 20;
  if (!existsSync(LOG_FILE)) {
    console.log(`no log file at ${LOG_FILE}`);
    return;
  }
  const text = await readFile(LOG_FILE, "utf8");
  const lines = text.split("\n");
  const last = lines.slice(Math.max(0, lines.length - 1 - n));
  console.log(last.join("\n"));
}

async function main(): Promise<void> {
  // Filter out --cwd <path> from the args; chdir before processing
  const argv = process.argv.slice(2);
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && i + 1 < argv.length) {
      process.chdir(argv[i + 1]!);
      i++;
      continue;
    }
    filtered.push(argv[i]!);
  }
  const cmd = filtered[0];
  if (cmd === "start") {
    await mkdir(dirname(PID_FILE), { recursive: true });
    await cmdStart(filtered.slice(1));
    return;
  }
  if (cmd === "stop") {
    await cmdStop();
    return;
  }
  if (cmd === "status") {
    await cmdStatus();
    return;
  }
  if (cmd === "logs") {
    await cmdLogs(filtered.slice(1));
    return;
  }
  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Walk up from this file looking for the first `node_modules`
 * directory. Yarn workspaces hoist everything there.
 */
function findNodeModulesPath(): string {
  let dir = __dirname;
  // safety bound — walk at most 10 levels
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, "node_modules");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}
