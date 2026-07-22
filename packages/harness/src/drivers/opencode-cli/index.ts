/**
 * OpenCode CLI adapter.
 *
 * Spawns the `opencode` CLI subprocess (installed via `npm i -g opencode-ai`)
 * and parses its `--format json` event stream. This is the same shape
 * the `claude_local` adapter uses for the Claude CLI.
 *
 * The CLI authenticates via `~/.local/share/opencode/auth.json` (set up
 * by `opencode providers` / `opencode auth login`). No API key in the
 * env is required — the CLI handles the keychain.
 *
 * Model names are the ones shown by `opencode models`, e.g.
 *   - opencode-go/mimo-v2.5
 *   - opencode-go/deepseek-v4-flash
 *   - opencode-go/glm-5.2
 *
 * Env (optional):
 *   OPENCODE_CLI     (default: "opencode")
 *   OPENCODE_CLI_DIR (default: process.cwd() — set this if the agent
 *                     should run in a specific worktree)
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  HARNESS_PROTOCOL_VERSION,
  type ServerAdapterModule,
} from "@aaspai/contracts/harness";
import { getLogger } from "@aaspai/observability";

const log = getLogger("harness.opencode-cli");

const CLI_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const STREAM_POLL_MS = 50;

const opencodeCliConfigSchema = {
  model: "opencode-go/mimo-v2.5",
  title: "OpenCode Session",
};

interface OpenCodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: {
    type: string;
    text?: string;
    messageID?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function shortId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

function resolveConfig(ctx: AdapterExecutionContext): { model: string; title: string } {
  const cfg = (ctx.config as Record<string, unknown>) ?? {};
  return {
    model: (cfg.model as string) ?? opencodeCliConfigSchema.model,
    title: (cfg.title as string) ?? opencodeCliConfigSchema.title,
  };
}

/**
 * Resolve the opencode binary path. On Windows, just spawning
 * "opencode" fails with ENOENT because npm-installed CLIs live in a
 * non-PATH directory. Look it up via the same `which`-style approach
 * npm scripts use.
 */
let cachedOpencodePath: string | null = null;
async function resolveOpencodeBinary(): Promise<string> {
  if (cachedOpencodePath && existsSync(cachedOpencodePath)) return cachedOpencodePath;

  // On Windows, the npm-installed "opencode" is a Git Bash shim that
  // Node's child_process can't reliably spawn. Go directly to the
  // underlying .exe that the .cmd shim wraps.
  if (process.platform === "win32") {
    const nodejsRoot = process.env.ProgramFiles
      ? `${process.env.ProgramFiles}\\nodejs`
      : "C:\\Program Files\\nodejs";
    const direct = [
      `${nodejsRoot}\\node_modules\\opencode-ai\\bin\\opencode.exe`,
      `${nodejsRoot}\\node_modules\\opencode-ai\\bin\\opencode`,
    ];
    for (const c of direct) {
      if (existsSync(c)) {
        cachedOpencodePath = c;
        return c;
      }
    }
    // Fall back to the .cmd wrapper (cmd.exe can run it)
    const cmdCandidates = [
      `${process.env.APPDATA ?? ""}\\npm\\opencode.cmd`,
      `${nodejsRoot}\\opencode.cmd`,
    ];
    for (const c of cmdCandidates) {
      if (existsSync(c)) {
        cachedOpencodePath = c;
        return c;
      }
    }
  }

  const exe = process.env.OPENCODE_CLI ?? "opencode";
  if (existsSync(exe)) {
    cachedOpencodePath = exe;
    return cachedOpencodePath;
  }

  // Try `which opencode` (POSIX) / `where opencode` (Windows)
  try {
    const exec = promisify(execFile);
    const cmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await exec(cmd, [exe]);
    const first = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (first) {
      cachedOpencodePath = first;
      return cachedOpencodePath;
    }
  } catch {
    // ignore
  }

  // Give up
  return exe;
}

async function runOpencodeCli(
  prompt: string,
  model: string,
  title: string,
  onLog: ((stream: "stdout" | "stderr", chunk: string) => Promise<void> | void) | undefined,
): Promise<{
  sessionId?: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  exitCode: number;
  timedOut: boolean;
}> {
  const cli = await resolveOpencodeBinary();
  const workdir = process.env.OPENCODE_CLI_DIR ?? process.cwd();

  const args = ["run", "--format", "json", "--model", model, "--title", title];
  // The opencode CLI accepts the prompt either as a positional arg
  // (useful when shell-handling is brittle) or via stdin. We use
  // positional when the binary is a .cmd shim, stdin when it's the
  // direct .exe.
  // Always pass the prompt as a positional arg. The CLI accepts it
  // whether spawned with stdin or not. On Windows, stdin handling
  // through a child_process pipe is unreliable — using a positional
  // arg is the deterministic path.
  args.push(prompt);

  return await new Promise((resolve, reject) => {
    // Don't use shell: true on Windows — it concatenates args into a
    // single command string and breaks paths with spaces ("C:\Program
    // Files"). Node can spawn the .cmd file directly without a shell.
    const child = spawn(cli, args, {
      cwd: workdir,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // Suppress unhandled EPIPE / write-after-end errors from stdio
    // streams — they fire as Node EventEmitter events and would crash
    // the process if not handled.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdin?.on("error", () => {});

    let stdoutBuf = "";
    let stderrBuf = "";
    let sessionId: string | undefined;
    const textParts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("opencode cli timeout, killing", { cli, timeoutMs: CLI_TIMEOUT_MS });
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        // If even SIGKILL doesn't work, resolve with what we have so
        // the session doesn't hang the worker.
        setTimeout(
          () =>
            resolve({
              sessionId: undefined,
              text: textParts.join(""),
              inputTokens,
              outputTokens,
              cost,
              exitCode: -1,
              timedOut: true,
            }),
          1000,
        );
      }, 5_000);
    }, CLI_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stdoutBuf += s;
      // opencode --format json emits one JSON event per line
      const nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        try {
          const ev = JSON.parse(line) as OpenCodeEvent;
          handleEvent(ev, onLog);
        } catch {
          // Not JSON — emit as a raw line
          void onLog?.("stdout", line);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stderrBuf += s;
      void onLog?.("stderr", s);
    });

    // Stdin is intentionally NOT used. The prompt was passed as a
    // positional arg above, which works on all platforms.
    if (child.stdin) {
      child.stdin.on("error", () => {});
      try {
        child.stdin.destroy();
      } catch {
        /* ignore */
      }
    }

    function handleEvent(ev: OpenCodeEvent, cb: typeof onLog): void {
      if (ev.sessionID) sessionId = ev.sessionID;
      if (ev.type === "text" && ev.part?.type === "text" && typeof ev.part.text === "string") {
        textParts.push(ev.part.text);
        void cb?.(
          "stdout",
          JSON.stringify({
            kind: "assistant",
            ts: new Date().toISOString(),
            text: ev.part.text,
          }) + "\n",
        );
      } else if (ev.type === "step_finish" && ev.part?.tokens) {
        const tokens = ev.part.tokens as {
          total?: number;
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { write?: number; read?: number };
        };
        if (typeof tokens.input === "number") inputTokens = Math.max(inputTokens, tokens.input);
        if (typeof tokens.output === "number") outputTokens = Math.max(outputTokens, tokens.output);
        if (typeof tokens.total === "number") {
          // fall back if per-direction counts are missing
          const inferred = tokens.total - inputTokens - outputTokens;
          if (inferred > 0) inputTokens = Math.max(inputTokens, inferred);
        }
        if (ev.part.cost) {
          const c = ev.part.cost as number;
          cost = Math.max(cost, c);
        }
        void cb?.(
          "stdout",
          JSON.stringify({
            kind: "result",
            ts: new Date().toISOString(),
            summary: textParts.join("").slice(0, 200),
            tokens,
            cost,
          }) + "\n",
        );
      } else {
        void cb?.(
          "stdout",
          JSON.stringify({
            kind: "init",
            ts: new Date().toISOString(),
            event: ev.type,
          }) + "\n",
        );
      }
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutBuf.trim().length > 0) {
        try {
          const ev = JSON.parse(stdoutBuf) as OpenCodeEvent;
          handleEvent(ev, onLog);
        } catch {
          /* ignore */
        }
      }
      resolve({
        sessionId,
        text: textParts.join(""),
        inputTokens,
        outputTokens,
        cost,
        exitCode: code ?? 0,
        timedOut,
      });
    });

    child.stdin?.end(prompt);
  });
}

/**
 * Per-process queue. The opencode CLI uses a single SQLite database
 * (default `~/.local/share/opencode/opencode.db`) and concurrent
 * invocations can race on writes. Serialize calls within this
 * process AND across processes via a file-based advisory lock.
 */
let cliChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = cliChain.then(fn, fn);
  cliChain = next.catch(() => undefined);
  return next;
}

/**
 * Cross-process lock. The opencode CLI is a single global state
 * machine for the user (one auth.json, one opencode.db), so we
 * serialize across processes too. Implemented as a tiny file in
 * the OS temp dir: the file holds this process's PID + hostname;
 * if it's stale (PID not running), we steal it. The lock is
 * blocking with a short retry loop (50ms × 200 = 10s max).
 */
const LOCK_PATH = process.env.AASPAI_OPENCODE_LOCK_PATH ?? join(tmpdir(), "aaspai-opencode.lock");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 10_000;
let lockChain: Promise<void> = Promise.resolve();

async function acquireLock(): Promise<() => void> {
  const myId = `${process.pid}@${hostname()}`;
  const startedAt = Date.now();
  // Queue our turn behind any other process waiting on the same
  // per-process promise chain.
  const myTurn = lockChain.then(async () => {
    while (true) {
      if (Date.now() - startedAt > LOCK_MAX_WAIT_MS) {
        throw new Error(`opencode_cli cross-process lock timeout after ${LOCK_MAX_WAIT_MS}ms`);
      }
      if (!existsSync(LOCK_PATH)) {
        try {
          const fd = openSync(LOCK_PATH, "wx");
          writeSync(fd, myId);
          closeSync(fd);
          return;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      // Lock file exists. Check if it's stale (PID not running).
      try {
        const holder = readFileSync(LOCK_PATH, "utf8").trim();
        const m = /^(\d+)@/.exec(holder);
        if (m) {
          const holderPid = Number(m[1]);
          if (holderPid !== process.pid && !isPidRunning(holderPid)) {
            // Stale lock — steal it.
            try {
              unlinkSync(LOCK_PATH);
            } catch {
              /* race: another process stole it first */
            }
            continue;
          }
        }
      } catch {
        /* unreadable; try again */
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  });
  lockChain = myTurn.catch(() => undefined);
  return async () => {
    await myTurn;
    // Only delete the lock if we still own it (the holder string
    // starts with our pid).
    try {
      const current = readFileSync(LOCK_PATH, "utf8").trim();
      if (current === myId) unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  };
}

function isPidRunning(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    // signal 0 is the POSIX "check if process exists" trick.
    // Windows doesn't have kill(pid, 0) but process.kill with no
    // signal returns true for live processes and throws ESRCH for
    // dead ones.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const opencodeCli: ServerAdapterModule = {
  info: {
    type: "opencode_cli",
    label: "OpenCode (CLI)",
    transport: "local_subprocess",
    models: [
      { id: "opencode-go/mimo-v2.5", label: "MiMo V2.5 (Xiaomi)" },
      { id: "opencode-go/mimo-v2.5-pro", label: "MiMo V2.5 Pro" },
      { id: "opencode-go/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "opencode-go/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "opencode-go/glm-5.2", label: "GLM 5.2" },
      { id: "opencode-go/kimi-k3", label: "Kimi K3" },
      { id: "opencode-go/qwen3.7-max", label: "Qwen 3.7 Max" },
    ],
    agentConfigurationDoc:
      "Spawns the opencode CLI (npm i -g opencode-ai). Auth via ~/.local/share/opencode/auth.json. Use `opencode models` to list available models.",
    status: "ready",
  },
  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const config = resolveConfig(ctx);
    const prompt =
      typeof ctx.context === "object" && ctx.context !== null && "prompt" in ctx.context
        ? String((ctx.context as { prompt: unknown }).prompt ?? "")
        : "";

    if (ctx.onMeta) {
      await ctx.onMeta({
        adapter: "opencode_cli",
        model: config.model,
        provider: "opencode-cli",
      });
    }

    // Acquire the cross-process lock (blocks until we have it),
    // then run inside the per-process serializer. The release
    // function is called in a finally so a throwing CLI doesn't
    // hold the lock forever.
    const release = await acquireLock();
    let cliResult: Awaited<ReturnType<typeof runOpencodeCli>>;
    try {
      cliResult = await serialize(() =>
        runOpencodeCli(prompt, config.model, config.title, ctx.onLog),
      );
    } finally {
      await release();
    }

    const sessionId = cliResult.sessionId ?? shortId("oc");
    return {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      sessionId,
      sessionDisplayId: sessionId.slice(0, 12),
      sessionParams: { model: config.model, cli: "opencode" },
      exitCode: cliResult.exitCode,
      timedOut: cliResult.timedOut,
      usage: {
        inputTokens: cliResult.inputTokens || estimateTokens(prompt),
        outputTokens: cliResult.outputTokens || estimateTokens(cliResult.text),
        cachedInputTokens: 0,
      },
      usageBasis: "per_run",
      costUsd: cliResult.cost > 0 ? cliResult.cost : undefined,
      billingType: "api",
      provider: "opencode",
      biller: "opencode-cli",
      model: config.model,
      summary: cliResult.text.slice(0, 500),
      clearSession: false,
      errorCode: cliResult.timedOut
        ? "timeout"
        : cliResult.exitCode !== 0
          ? "opencode_cli_failed"
          : undefined,
      errorFamily: cliResult.timedOut
        ? "transient_upstream"
        : cliResult.exitCode !== 0
          ? "internal"
          : undefined,
    };
  },
  async testEnvironment() {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const cli = process.env.OPENCODE_CLI ?? "opencode";
      const { stdout } = await exec(cli, ["--version"]);
      return {
        ok: true,
        checks: [{ name: "opencode_cli", level: "info", message: `${cli} ${stdout.trim()}` }],
      };
    } catch (err) {
      return {
        ok: false,
        checks: [
          { name: "opencode_cli", level: "error", message: `not found: ${(err as Error).message}` },
        ],
      };
    }
  },
};

export const opencodeCliInfo = opencodeCli.info;
