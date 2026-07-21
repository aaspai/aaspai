/**
 * aaspai-api CLI — start / stop / status.
 *
 * Run:
 *   aaspai-api start
 *   aaspai-api start --daemon
 *   aaspai-api stop
 *   aaspai-api status
 *
 * Env:
 *   AASPAI_API_HOST     (default: 127.0.0.1)
 *   AASPAI_API_PORT     (default: 7420)
 */
import { writeFile, readFile, unlink, mkdir, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { startServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const PID_FILE = ".aaspai/api.pid";
const LOG_FILE = ".aaspai/api.log";

function usage(): never {
  console.log(`aaspai-api — the HTTP control plane

Usage:
  aaspai-api start [--daemon]
  aaspai-api stop
  aaspai-api status
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
    console.error(`api is already running (pid ${existing})`);
    process.exit(1);
  }

  if (daemon) {
    await mkdir(dirname(LOG_FILE), { recursive: true });
    const logFd = await open(LOG_FILE, "a");
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
    // Note: child writes its own PID after confirming it's running.
    if (child.pid === undefined) {
      throw new Error("failed to spawn background api (no pid)");
    }
    const port = process.env.AASPAI_API_PORT ?? "7420";
    console.log(`aaspai-api started (pid ${child.pid}, http://127.0.0.1:${port}, logs: ${LOG_FILE})`);
    return;
  }

  const running = await startServer();
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await running.close();
    try { await unlink(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  // Write PID AFTER the server is listening so the parent's "started"
  // log line is honest.
  await writeFile(PID_FILE, String(process.pid), "utf8");
  await new Promise(() => {});
}

async function cmdStop(): Promise<void> {
  const pid = await readPid();
  if (pid === null) {
    console.log("api is not running");
    return;
  }
  if (!isRunning(pid)) {
    console.log("api pid file is stale; cleaning up");
    try { await unlink(PID_FILE); } catch { /* ignore */ }
    return;
  }
  console.log(`stopping api (pid ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 100; i++) {
      if (!isRunning(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isRunning(pid)) {
      console.log("api did not exit gracefully; sending SIGKILL");
      process.kill(pid, "SIGKILL");
    }
  } catch (err) {
    console.error(`failed to kill pid ${pid}: ${(err as Error).message}`);
  }
  try { await unlink(PID_FILE); } catch { /* ignore */ }
  console.log("api stopped");
}

async function cmdStatus(): Promise<void> {
  const pid = await readPid();
  if (pid === null || !isRunning(pid)) {
    console.log("api is not running");
    return;
  }
  const port = process.env.AASPAI_API_PORT ?? "7420";
  console.log(`api is running (pid ${pid}, http://127.0.0.1:${port})`);
  if (existsSync(LOG_FILE)) {
    const stat = await import("node:fs/promises").then((m) => m.stat(LOG_FILE));
    console.log(`log file: ${LOG_FILE} (${(stat.size / 1024).toFixed(1)} KB)`);
  }
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
  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function findNodeModulesPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, "node_modules");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

