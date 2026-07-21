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
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { HARNESS_PROTOCOL_VERSION, type AdapterExecutionContext, type AdapterExecutionResult, type ServerAdapterModule } from "@aaspai/contracts/harness";
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
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
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

  const args = [
    "run",
    "--format",
    "json",
    "--model",
    model,
    "--title",
    title,
  ];
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
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        // If even SIGKILL doesn't work, resolve with what we have so
        // the session doesn't hang the worker.
        setTimeout(() => resolve({
          sessionId: undefined,
          text: textParts.join(""),
          inputTokens,
          outputTokens,
          cost,
          exitCode: -1,
          timedOut: true,
        }), 1000);
      }, 5_000);
    }, CLI_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stdoutBuf += s;
      // opencode --format json emits one JSON event per line
      let nl: number;
      // eslint-disable-next-line no-cond-assign
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
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
      try { child.stdin.destroy(); } catch { /* ignore */ }
    }


    function handleEvent(
      ev: OpenCodeEvent,
      cb: typeof onLog,
    ): void {
      if (ev.sessionID) sessionId = ev.sessionID;
      if (ev.type === "text" && ev.part?.type === "text" && typeof ev.part.text === "string") {
        textParts.push(ev.part.text);
        void cb?.("stdout", JSON.stringify({
          kind: "assistant",
          ts: new Date().toISOString(),
          text: ev.part.text,
        }) + "\n");
      } else if (ev.type === "step_finish" && ev.part?.tokens) {
        const tokens = ev.part.tokens as {
          total?: number; input?: number; output?: number;
          reasoning?: number; cache?: { write?: number; read?: number };
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
        void cb?.("stdout", JSON.stringify({
          kind: "result",
          ts: new Date().toISOString(),
          summary: textParts.join("").slice(0, 200),
          tokens,
          cost,
        }) + "\n");
      } else {
        void cb?.("stdout", JSON.stringify({
          kind: "init",
          ts: new Date().toISOString(),
          event: ev.type,
        }) + "\n");
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
        } catch { /* ignore */ }
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
 * process; cross-process concurrency still races but is rare in
 * the foundation slice (single worker).
 */
let cliChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = cliChain.then(fn, fn);
  cliChain = next.catch(() => undefined);
  return next;
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
    const prompt = typeof ctx.context === "object" && ctx.context !== null && "prompt" in ctx.context
      ? String((ctx.context as { prompt: unknown }).prompt ?? "")
      : "";

    if (ctx.onMeta) {
      await ctx.onMeta({
        adapter: "opencode_cli",
        model: config.model,
        provider: "opencode-cli",
      });
    }

    const cliResult = await serialize(() =>
      runOpencodeCli(prompt, config.model, config.title, ctx.onLog),
    );

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
      errorCode: cliResult.timedOut ? "timeout" : (cliResult.exitCode !== 0 ? "opencode_cli_failed" : undefined),
      errorFamily: cliResult.timedOut
        ? "transient_upstream"
        : (cliResult.exitCode !== 0 ? "internal" : undefined),
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
        checks: [
          { name: "opencode_cli", level: "info", message: `${cli} ${stdout.trim()}` },
        ],
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
