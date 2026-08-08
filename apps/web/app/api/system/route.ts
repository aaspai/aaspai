import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NextResponse } from "next/server";
import { isAaspaiWorkspace, workspaceRoot } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export const dynamic = "force-dynamic";

const DAEMONS = {
  worker: { pidFile: ".aaspai/worker.pid", workspace: "@aaspai/worker" },
  api: { pidFile: ".aaspai/api.pid", workspace: "@aaspai/api" },
} as const;

type DaemonKey = keyof typeof DAEMONS;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidFile: string): Promise<number | null> {
  const file = join(workspaceRoot(), pidFile);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, "utf8");
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function resolveWorkspaceDir(): string | null {
  try {
    return resolve(workspaceRoot(), "node_modules");
  } catch {
    return null;
  }
}

function respawnDaemon(key: DaemonKey): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const { workspace } = DAEMONS[key];
    const root = workspaceRoot();
    const yarn = process.platform === "win32" ? "yarn.cmd" : "yarn";
    const child = spawn(
      yarn,
      ["workspace", workspace, "start", "start", "--daemon", "--cwd", root],
      {
        cwd: root,
        env: { ...process.env, AASPAI_CWD: root },
        stdio: "ignore",
        detached: process.platform !== "win32",
      },
    );
    child.unref();
    child.once("error", (err) => reject(err));
    child.once("spawn", () => resolvePromise());
  });
}

async function signalTarget(key: DaemonKey): Promise<{ pid: number | null; killed: boolean }> {
  const { pidFile } = DAEMONS[key];
  const pid = await readPid(pidFile);
  if (pid === null || !isRunning(pid)) return { pid, killed: false };
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50; i += 1) {
      if (!isRunning(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isRunning(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    return { pid, killed: false };
  }
  return { pid, killed: true };
}

/** `GET /api/system` — daemon + web status. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const status: Record<string, { pid: number | null; running: boolean }> = {};
  for (const key of Object.keys(DAEMONS) as DaemonKey[]) {
    const pid = await readPid(DAEMONS[key].pidFile);
    status[key] = { pid, running: pid !== null && isRunning(pid) };
  }
  return NextResponse.json({
    daemons: status,
    web: { running: true },
    nodeModules: resolveWorkspaceDir() !== null,
  });
}

/** `POST /api/system/restart` — restart a daemon. Body: `{ target: "worker" | "api" }`. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  let body: { target?: unknown };
  try {
    body = (await req.json()) as { target?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const target = String(body.target ?? "");
  if (target !== "worker" && target !== "api") {
    return NextResponse.json({ error: "target must be 'worker' or 'api'" }, { status: 400 });
  }
  const key = target as DaemonKey;
  const { pid, killed } = await signalTarget(key);
  // Only auto-respawn when we can reach the workspace (daemonized
  // installs). If the daemon was launched by `yarn dev`, the supervisor
  // owns respawn; signalling is enough.
  const respawned = killed && resolveWorkspaceDir() !== null;
  if (killed && respawned) {
    try {
      await respawnDaemon(key);
    } catch (err) {
      return NextResponse.json(
        { target, pid, killed, respawned: false, error: String(err) },
        { status: 500 },
      );
    }
  }
  return NextResponse.json({ target, pid, killed, respawned });
}
