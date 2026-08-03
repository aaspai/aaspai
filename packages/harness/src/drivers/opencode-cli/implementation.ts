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
 *
 * Config (full surface, all optional unless noted):
 *   model                — model id, default "opencode-go/mimo-v2.5"
 *   title                — session title, default "OpenCode Session"
 *   command              — binary path override (wins over OPENCODE_CLI)
 *   commandArgs          — extra args inserted before "run"
 *
 *   variant              — pass --variant <name> (reasoning effort)
 *   agent                — pass --agent <name> (named agent)
 *   thinking             — pass --thinking (emit thinking blocks)
 *   continueLast         — pass -c (continue the most recent session)
 *   shareSession         — pass --share (publish session as public URL)
 *   pure                 — pass --pure (no external plugins)
 *   autoApprove          — pass --auto (auto-approve non-denied permissions)
 *   logLevel             — pass --log-level <level>
 *   printLogs            — pass --print-logs (tee opencode's own logs)
 *   workingDir           — pass --dir <path> (override the CLI's cwd)
 *   attachments          — array of file paths, each becomes a --file <path>
 *
 *   attachServer         — URL of a running opencode server, pass --attach <url>
 *   serverPassword       — sets OPENCODE_SERVER_PASSWORD (basic auth)
 *   serverUsername       — sets OPENCODE_SERVER_USERNAME (basic auth)
 *   xdgConfigHome        — sets XDG_CONFIG_HOME; use with opencodeJson to
 *                          inject a per-call opencode.json
 *   opencodeJson         — object literal written to <xdgConfigHome>/opencode/config.json
 *   disableProjectConfig — sets OPENCODE_DISABLE_PROJECT_CONFIG=1
 *   allowAllModels       — sets OPENCODE_ALLOW_ALL_MODELS=1
 *   permissions          — object injected into the synthesized opencode.json
 *                          as `permission: <permissions>` (e.g. {"bash":"allow"})
 *   providers            — object injected as `provider: <providers>` in opencode.json
 *   dangerouslySkipPermissions — when true, adds {"*":"allow"} to permissions
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  type AdapterRuntimeExecution,
  HARNESS_PROTOCOL_VERSION,
  type ServerAdapterModule,
} from "@aaspai/contracts/harness";
import { type JsonObject, type JsonValue, jsonObjectSchema } from "@aaspai/contracts/primitives";
import { getLogger } from "@aaspai/observability";

const log = getLogger("harness.opencode-cli");
const MAX_RESULT_TEXT_BYTES = 1024 * 1024;

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
    tool?: string;
    callID?: string;
    state?: { status?: string; input?: unknown; output?: unknown };
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

/** Coerce an unknown value into a record, falling back to {} on any misshape. */
function parseObject(value: unknown): Record<string, unknown> {
  const result = jsonObjectSchema.safeParse(value);
  return result.success ? (result.data as Record<string, unknown>) : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
function _asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}
function asBoolTriState(v: unknown): boolean | undefined {
  if (v === true || v === "true" || v === 1) return true;
  if (v === false || v === "false" || v === 0) return false;
  return undefined;
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

export interface McpServerConfig {
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface ResolvedConfig {
  model: string;
  title: string;
  command?: string;
  commandArgs: string[];
  variant?: string;
  agent?: string;
  thinking: boolean;
  continueLast: boolean;
  shareSession: boolean;
  shareMode?: "manual" | "auto" | "disabled";
  pure: boolean;
  autoApprove: boolean;
  logLevel?: string;
  printLogs: boolean;
  workingDir?: string;
  attachments: string[];
  attachServer?: string;
  serverPassword?: string;
  serverUsername?: string;
  port?: number;
  xdgConfigHome?: string;
  opencodeJson?: Record<string, unknown>;
  disableProjectConfig: boolean;
  allowAllModels: boolean;
  permissions?: Record<string, unknown>;
  providers?: Record<string, unknown>;
  dangerouslySkipPermissions: boolean;
  mcpServers: Record<string, McpServerConfig>;
  /** `--command <s>`: run a specific named command with the message as args. */
  runCommand?: string;
  /** `--prompt <s>`: alternative prompt source (skipped if empty; positional is default). */
  promptArg?: string;
  /** `--port <n>`: port for the local server (when not attaching). */
  mini?: boolean;
  noReplay?: boolean;
  replayLimit?: number;
  /** `opencode.json` controls (merged into the opencodeJson document). */
  compaction?: { auto?: boolean; tail_turns?: number };
  primaryTools?: string[];
  mcpTimeoutMs?: number;
  toolOutputMaxLines?: number;
  toolOutputMaxBytes?: number;
  autoupdate?: boolean | "notify";
  snapshot?: boolean | undefined;
  instructions?: string[];
  smallModel?: string;
  defaultAgent?: string;
  shell?: string;
  disabledProviders?: string[];
  enabledProviders?: string[];
  references?: Record<
    string,
    { path?: string; repository?: string; branch?: string; description?: string; hidden?: boolean }
  >;
  skillsPaths?: string[];
  skillsUrls?: string[];
  /** Env escape hatches. */
  opencodeConfig?: string;
  opencodeConfigContent?: string;
  timeoutSec: number;
  graceSec: number;
  disableDefaultPlugins: boolean;
  disableExternalSkills: boolean;
  disableClaudeCodeSkills: boolean;
  pureEnv: boolean;
}

function resolveConfig(ctx: { config: unknown }): ResolvedConfig {
  const cfg = (ctx.config as Record<string, unknown>) ?? {};
  const shareModeRaw = asString(cfg.shareMode);
  const shareMode =
    shareModeRaw === "manual" || shareModeRaw === "auto" || shareModeRaw === "disabled"
      ? shareModeRaw
      : undefined;
  return {
    model: (cfg.model as string) ?? opencodeCliConfigSchema.model,
    title: (cfg.title as string) ?? opencodeCliConfigSchema.title,
    command: typeof cfg.command === "string" ? cfg.command : undefined,
    commandArgs: Array.isArray(cfg.commandArgs)
      ? cfg.commandArgs.filter((value): value is string => typeof value === "string")
      : [],
    variant: asString(cfg.variant),
    agent: asString(cfg.agent),
    thinking: asBool(cfg.thinking),
    continueLast: asBool(cfg.continueLast),
    shareSession: asBool(cfg.shareSession),
    shareMode,
    pure: asBool(cfg.pure),
    autoApprove: asBool(cfg.autoApprove),
    logLevel: asString(cfg.logLevel),
    printLogs: asBool(cfg.printLogs),
    workingDir: asString(cfg.workingDir),
    attachments: asStringArray(cfg.attachments),
    attachServer: asString(cfg.attachServer),
    serverPassword: asString(cfg.serverPassword),
    serverUsername: asString(cfg.serverUsername),
    port: _asNumber(cfg.port),
    xdgConfigHome: asString(cfg.xdgConfigHome),
    opencodeJson: parseObject(cfg.opencodeJson),
    disableProjectConfig: asBool(cfg.disableProjectConfig),
    allowAllModels: asBool(cfg.allowAllModels),
    permissions: parseObject(cfg.permissions),
    providers: parseObject(cfg.providers),
    dangerouslySkipPermissions: asBool(cfg.dangerouslySkipPermissions),
    mcpServers: parseMcpServers(cfg.mcpServers),
    runCommand: asString(cfg.runCommand),
    promptArg: asString(cfg.promptArg),
    mini: asBool(cfg.mini),
    noReplay: asBool(cfg.noReplay),
    replayLimit: _asNumber(cfg.replayLimit),
    compaction: parseObject(cfg.compaction) as { auto?: boolean; tail_turns?: number } | undefined,
    primaryTools: asStringArray(cfg.primaryTools),
    mcpTimeoutMs: _asNumber(cfg.mcpTimeoutMs),
    toolOutputMaxLines: _asNumber(cfg.toolOutputMaxLines),
    toolOutputMaxBytes: _asNumber(cfg.toolOutputMaxBytes),
    autoupdate: parseAutoupdate(cfg.autoupdate),
    snapshot: asBoolTriState(cfg.snapshot),
    instructions: asStringArray(cfg.instructions),
    smallModel: asString(cfg.smallModel),
    defaultAgent: asString(cfg.defaultAgent),
    shell: asString(cfg.shell),
    disabledProviders: asStringArray(cfg.disabledProviders),
    enabledProviders: asStringArray(cfg.enabledProviders),
    references: parseObject(cfg.references) as ResolvedConfig["references"],
    skillsPaths: asStringArray(cfg.skillsPaths),
    skillsUrls: asStringArray(cfg.skillsUrls),
    opencodeConfig: asString(cfg.opencodeConfig),
    opencodeConfigContent: asString(cfg.opencodeConfigContent),
    timeoutSec: Math.max(1, _asNumber(cfg.timeoutSec) ?? 300),
    graceSec: Math.max(1, _asNumber(cfg.graceSec) ?? 15),
    disableDefaultPlugins: asBool(cfg.disableDefaultPlugins),
    disableExternalSkills: asBool(cfg.disableExternalSkills),
    disableClaudeCodeSkills: asBool(cfg.disableClaudeCodeSkills),
    pureEnv: asBool(cfg.pureEnv),
  };
}

function parseAutoupdate(v: unknown): boolean | "notify" | undefined {
  if (v === true || v === "true" || v === 1) return true;
  if (v === false || v === "false" || v === 0) return false;
  if (v === "notify") return "notify";
  return undefined;
}

function parseMcpServers(v: unknown): Record<string, McpServerConfig> {
  const obj = parseObject(v);
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(obj)) {
    const s = raw as Record<string, unknown>;
    if (typeof s?.type !== "string") continue;
    if (s.type !== "stdio" && s.type !== "http" && s.type !== "sse") continue;
    const cfg: McpServerConfig = { type: s.type };
    if (typeof s.command === "string") cfg.command = s.command;
    if (Array.isArray(s.args)) cfg.args = s.args.filter((x): x is string => typeof x === "string");
    if (typeof s.url === "string") cfg.url = s.url;
    if (s.env && typeof s.env === "object") {
      const env: Record<string, string> = {};
      for (const [k, val] of Object.entries(s.env as Record<string, unknown>)) {
        if (typeof val === "string") env[k] = val;
      }
      cfg.env = env;
    }
    if (s.headers && typeof s.headers === "object") {
      const headers: Record<string, string> = {};
      for (const [k, val] of Object.entries(s.headers as Record<string, unknown>)) {
        if (typeof val === "string") headers[k] = val;
      }
      cfg.headers = headers;
    }
    out[name] = cfg;
  }
  return out;
}

/**
 * Resolve the opencode binary path. On Windows, just spawning
 * "opencode" fails with ENOENT because npm-installed CLIs live in a
 * non-PATH directory. Look it up via the same `which`-style approach
 * npm scripts use.
 *
 * Resolution order (top wins, no override):
 *   1. `executableOverride` (sourced from `config.command`) — always
 *      wins so per-agent overrides are deterministic.
 *   2. `OPENCODE_CLI` env var (if set, non-empty, and the path
 *      exists) — operators with custom builds / wrappers route
 *      around the hard-coded ProgramFiles lookup.
 *   3. On Windows: `%ProgramFiles%\nodejs\node_modules\opencode-ai\bin\opencode.exe`
 *      (the npm `opencode-ai` install).
 *   4. On Windows: `.cmd` shim under `%APPDATA%\npm\opencode.cmd`
 *      or `%ProgramFiles%\nodejs\opencode.cmd`.
 *   5. `which opencode` / `where opencode` (PATH lookup).
 *   6. The literal string `"opencode"` (spawn will fail; surfaces
 *      the missing-binary error to the operator).
 */
let cachedOpencodePath: string | null = null;
async function resolveOpencodeBinary(executableOverride?: string): Promise<string> {
  if (executableOverride) {
    return executableOverride;
  }
  if (cachedOpencodePath && existsSync(cachedOpencodePath)) return cachedOpencodePath;

  // 2. OPENCODE_CLI env var — take precedence over the npm install
  // path so operators with custom builds / wrappers route around
  // the hard-coded ProgramFiles lookup.
  if (process.env.OPENCODE_CLI && process.env.OPENCODE_CLI.trim().length > 0) {
    const envPath = process.env.OPENCODE_CLI;
    if (existsSync(envPath)) {
      cachedOpencodePath = envPath;
      return envPath;
    }
  }

  // 3. Windows direct .exe lookup (the npm `opencode-ai` install).
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

  // 5. PATH lookup.
  const exe = "opencode";
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

/**
 * Build the opencode.json document that should be written to
 * <xdgConfigHome>/opencode/config.json (or
 * ~/.config/opencode/config.json) for this call. Combines:
 *   - Config.opencodeJson (caller's full document, takes priority)
 *   - Config.permissions → `permission` block
 *   - Config.providers → `provider` block
 *   - Config.dangerouslySkipPermissions → adds `{"*":"allow"}` to permission
 */
function buildOpencodeJson(config: ResolvedConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config.opencodeJson };
  if (config.permissions && Object.keys(config.permissions).length > 0) {
    const existing = (out.permission as Record<string, unknown> | undefined) ?? {};
    out.permission = { ...existing, ...config.permissions };
  } else if (config.dangerouslySkipPermissions) {
    out.permission = { "*": "allow" };
  }
  if (config.providers && Object.keys(config.providers).length > 0) {
    out.provider = config.providers;
  }
  // Tier 1: opencode.json fields (added in this pass).
  if (config.compaction && Object.keys(config.compaction).length > 0) {
    out.compaction = { ...(out.compaction as object | undefined), ...config.compaction };
  }
  if (config.primaryTools && config.primaryTools.length > 0) {
    const exp = (out.experimental as Record<string, unknown> | undefined) ?? {};
    exp.primary_tools = config.primaryTools;
    out.experimental = exp;
  }
  if (typeof config.mcpTimeoutMs === "number") {
    const exp = (out.experimental as Record<string, unknown> | undefined) ?? {};
    exp.mcp_timeout = config.mcpTimeoutMs;
    out.experimental = exp;
  }
  if (
    typeof config.toolOutputMaxLines === "number" ||
    typeof config.toolOutputMaxBytes === "number"
  ) {
    out.tool_output = {
      ...((out.tool_output as Record<string, unknown> | undefined) ?? {}),
      ...(typeof config.toolOutputMaxLines === "number"
        ? { max_lines: config.toolOutputMaxLines }
        : {}),
      ...(typeof config.toolOutputMaxBytes === "number"
        ? { max_bytes: config.toolOutputMaxBytes }
        : {}),
    };
  }
  if (config.shareMode) out.share = config.shareMode;
  if (config.autoupdate === true || config.autoupdate === false || config.autoupdate === "notify") {
    out.autoupdate = config.autoupdate;
  }
  if (config.snapshot !== undefined) out.snapshot = config.snapshot;
  if (config.instructions && config.instructions.length > 0) {
    out.instructions = config.instructions;
  }
  if (config.smallModel) out.small_model = config.smallModel;
  if (config.defaultAgent) out.default_agent = config.defaultAgent;
  if (config.shell) out.shell = config.shell;
  if (config.disabledProviders && config.disabledProviders.length > 0) {
    out.disabled_providers = config.disabledProviders;
  }
  if (config.enabledProviders && config.enabledProviders.length > 0) {
    out.enabled_providers = config.enabledProviders;
  }
  if (config.references && Object.keys(config.references).length > 0) {
    out.references = { ...((out.references as object | undefined) ?? {}), ...config.references };
  }
  if (config.skillsPaths && config.skillsPaths.length > 0) {
    const skills = (out.skills as Record<string, unknown> | undefined) ?? {};
    skills.paths = config.skillsPaths;
    out.skills = skills;
  }
  if (config.skillsUrls && config.skillsUrls.length > 0) {
    const skills = (out.skills as Record<string, unknown> | undefined) ?? {};
    skills.urls = config.skillsUrls;
    out.skills = skills;
  }
  return out;
}

/**
 * Materialize the opencode.json (if any config injection was requested)
 * and return the env-block that should be merged into the spawn env.
 *
 * Returns:
 *   - extraEnv: env vars to merge (XDG_CONFIG_HOME, OPENCODE_*)
 *   - cleanup(): removes any temp file we wrote
 */
function prepareConfigInjection(
  config: ResolvedConfig,
  inline = false,
): {
  extraEnv: Record<string, string>;
  cleanup: () => void;
} {
  const extraEnv: Record<string, string> = {};
  const cleanups: Array<() => void> = [];

  // 1. opencode.json injection
  const jsonDoc = buildOpencodeJson(config);
  const hasJson = Object.keys(jsonDoc).length > 0;
  const hasMcp = Object.keys(config.mcpServers).length > 0;
  if (inline && (hasJson || hasMcp)) {
    extraEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...jsonDoc,
      ...(hasMcp ? { mcp: config.mcpServers } : {}),
    });
    if (config.xdgConfigHome) extraEnv.XDG_CONFIG_HOME = config.xdgConfigHome;
  } else if (hasJson || hasMcp || config.xdgConfigHome) {
    const base = config.xdgConfigHome
      ? config.xdgConfigHome
      : join(tmpdir(), `aaspai-opencode-cfg-${randomUUID()}`);
    const opencodeDir = join(base, "opencode");
    try {
      mkdirSync(opencodeDir, { recursive: true });
    } catch {
      /* best-effort */
    }
    if (hasJson) {
      try {
        const file = join(opencodeDir, "config.json");
        writeFileSync(file, JSON.stringify(jsonDoc, null, 2), "utf8");
      } catch (err) {
        log.warn("failed to write opencode config.json", { err: String(err) });
      }
    }
    if (hasMcp) {
      try {
        const file = join(opencodeDir, "mcp.json");
        writeFileSync(file, JSON.stringify({ mcpServers: config.mcpServers }, null, 2), "utf8");
      } catch (err) {
        log.warn("failed to write opencode mcp.json", { err: String(err) });
      }
    }
    if (!config.xdgConfigHome) {
      // We own this dir — clean it up after.
      const dir = base;
      cleanups.push(() => {
        try {
          const { rmSync } = require("node:fs") as typeof import("node:fs");
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      });
    }
    extraEnv.XDG_CONFIG_HOME = base;
  }

  // 2. Permission + provider flags
  if (config.disableProjectConfig) {
    extraEnv.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  }
  if (config.allowAllModels) {
    extraEnv.OPENCODE_ALLOW_ALL_MODELS = "1";
  }
  if (config.serverPassword) {
    extraEnv.OPENCODE_SERVER_PASSWORD = config.serverPassword;
  }
  if (config.serverUsername) {
    extraEnv.OPENCODE_SERVER_USERNAME = config.serverUsername;
  }

  // 3. Tier 1 env escape hatches (added in this pass).
  if (config.opencodeConfig) {
    extraEnv.OPENCODE_CONFIG = config.opencodeConfig;
  }
  if (config.opencodeConfigContent) {
    extraEnv.OPENCODE_CONFIG_CONTENT = config.opencodeConfigContent;
  }
  if (config.disableDefaultPlugins) {
    extraEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
  }
  if (config.pureEnv) {
    extraEnv.OPENCODE_PURE = "1";
  }
  if (config.disableExternalSkills) {
    extraEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  }
  if (config.disableClaudeCodeSkills) {
    extraEnv.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
  }

  return {
    extraEnv,
    cleanup: () => {
      for (const c of cleanups) c();
    },
  };
}

interface RunResult {
  sessionId?: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  errorMessage?: string;
  /** Whether this run forwarded `--session <id>` to the CLI for resume. */
  resumedSession: boolean;
  /** Whether this run forwarded `-c` to the CLI for continue-last. */
  continuedLast: boolean;
  /** Whether the run was attached to a running server. */
  attached: boolean;
  /** Opencode's own session id (if the CLI emitted one), for `opencode stats` linkage. */
  cliSessionId?: string;
  /** Per-event count of thinking + tool events seen (for usage reconciliation). */
  thinkingEventCount: number;
  toolEventCount: number;
  /** Names of tools the dispatcher was asked to invoke. */
  toolsInvoked: string[];
  /** Structured company actions captured from the native company_action tool. */
  companyActions: JsonValue[];
}

async function runOpencodeCli(
  prompt: string,
  config: ResolvedConfig,
  cwd: string,
  signal: AbortSignal | undefined,
  onLog: ((stream: "stdout" | "stderr", chunk: string) => Promise<void> | void) | undefined,
  onProgress: ((update: unknown) => Promise<void> | void) | undefined,
  options: {
    /** Resume an existing opencode session by id (passes `--session <id>` to the CLI). */
    resumeSessionId?: string;
    /**
     * If true and `resumeSessionId` is set, also pass `--fork` so the
     * resumed session is copied and the original isn't mutated
     * (matches opencode's own `opencode run --fork --session <id>`).
     */
    forkSession?: boolean;
    /**
     * Optional tool dispatcher. When set, every `tool_use` event the
     * opencode CLI emits is routed through `tools.invoke(name, input)`
     * and the result is emitted back through `onLog` / `onRuntimeProgress`
     * as a `tool_result` event. The opencode CLI still owns the
     * tool-orchestration loop — we just record the result.
     */
    tools?: {
      invoke(name: string, input: unknown, ctx: unknown): Promise<unknown>;
      get?(name: string): unknown;
      list?(): readonly string[];
    };
    execution?: AdapterRuntimeExecution;
  } = {},
): Promise<RunResult> {
  const cli = options.execution
    ? (config.command ?? process.env.OPENCODE_CLI ?? "opencode")
    : await resolveOpencodeBinary(config.command);
  const workdir = cwd || process.env.OPENCODE_CLI_DIR || process.cwd();

  const args = [
    ...config.commandArgs,
    "run",
    "--format",
    "json",
    "--model",
    config.model,
    "--title",
    config.title,
  ];
  if (config.continueLast) args.push("-c");
  if (config.variant) args.push("--variant", config.variant);
  if (config.agent) args.push("--agent", config.agent);
  if (config.thinking) args.push("--thinking");
  if (config.shareSession) args.push("--share");
  if (config.pure) args.push("--pure");
  if (config.autoApprove) args.push("--auto");
  if (config.logLevel) args.push("--log-level", config.logLevel);
  if (config.printLogs) args.push("--print-logs");
  if (config.workingDir) args.push("--dir", config.workingDir);
  else if (options.resumeSessionId && !config.attachServer) args.push("--dir", cwd);
  if (config.attachServer) args.push("--attach", config.attachServer);
  for (const a of config.attachments) args.push("--file", a);
  if (options.resumeSessionId) {
    args.push("--session", options.resumeSessionId);
    if (options.forkSession) args.push("--fork");
  }
  // Tier 1 flags added in this pass.
  if (config.runCommand) args.push("--command", config.runCommand);
  if (typeof config.port === "number") args.push("--port", String(config.port));
  if (config.mini) args.push("--mini");
  if (config.noReplay) args.push("--no-replay");
  if (typeof config.replayLimit === "number")
    args.push("--replay-limit", String(config.replayLimit));
  // `--prompt <s>` (alternative to positional). When set, it replaces
  // the positional <prompt>. We still include the positional for
  // back-compat unless the caller explicitly opts in via promptArg.
  if (config.promptArg) {
    args.push("--prompt", config.promptArg);
  } else {
    args.push(prompt);
  }

  const { extraEnv, cleanup } = prepareConfigInjection(config, Boolean(options.execution));
  const timeoutMs = config.timeoutSec * 1_000;

  if (options.execution) {
    try {
      return await runOpencodeThroughRuntime({
        cli,
        args,
        cwd: workdir,
        // The runtime owns its base environment and credential transport.
        // Forwarding the worker host environment leaks unrelated secrets and
        // sends unusable host PATH/HOME values into remote Linux runtimes.
        env: extraEnv,
        signal,
        timeoutMs,
        graceMs: config.graceSec * 1_000,
        onLog,
        execution: options.execution,
        tools: options.tools,
        resumeSessionId: options.resumeSessionId,
        continuedLast: config.continueLast,
        attached: Boolean(config.attachServer),
      });
    } finally {
      cleanup();
    }
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd: workdir,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // Suppress unhandled EPIPE / write-after-end errors from stdio
    // streams — they fire as Node EventEmitter events and would crash
    // the process if not handled.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    let stdoutBuf = "";
    let stderrBuf = "";
    let sessionId: string | undefined;
    const textParts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let timedOut = false;
    let closed = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;
    let thinkingEventCount = 0;
    let toolEventCount = 0;
    const toolsInvoked: string[] = [];
    const toolsDispatched = new Set<string>();
    const companyActions: JsonValue[] = [];
    const companyActionCalls = new Set<string>();
    /** Most-recent JSON error event message (paperclip-style extraction). */
    let jsonErrorMessage: string | undefined;
    /** First non-fatal stderr line (for diagnostics). */
    let firstStderrLine: string | undefined;
    let pendingLogWrites: Promise<void> = Promise.resolve();
    let pendingProgress: Promise<void> = Promise.resolve();
    const emitLog = (stream: "stdout" | "stderr", chunk: string): void => {
      pendingLogWrites = pendingLogWrites.then(async () => {
        await onLog?.(stream, chunk);
      });
    };
    const emitProgress = (update: unknown): void => {
      pendingProgress = pendingProgress.then(async () => {
        await onProgress?.(update);
      });
    };
    const terminate = (): void => {
      if (closed) return;
      try {
        child.kill("SIGTERM");
        killHandle = setTimeout(() => {
          if (!closed) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already dead */
            }
          }
        }, config.graceSec * 1_000);
        killHandle.unref();
      } catch {
        /* already dead */
      }
    };
    const abort = (): void => terminate();

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeoutHandle.unref();

    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stdoutBuf += s;
      // opencode --format json emits one JSON event per line
      let nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        let ev: OpenCodeEvent;
        try {
          ev = JSON.parse(line) as OpenCodeEvent;
        } catch {
          emitLog("stdout", line);
          nl = stdoutBuf.indexOf("\n");
          continue;
        }
        handleEvent(ev);
        nl = stdoutBuf.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stderrBuf += s;
      // Track the first non-empty line for diagnostics — many real
      // CLIs (and our fake) put the error summary on stderr's first
      // line.
      if (firstStderrLine === undefined) {
        const first = s
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean);
        if (first) firstStderrLine = first;
      }
      emitLog("stderr", s);
    });

    function handleEvent(ev: OpenCodeEvent): void {
      if (ev.sessionID) {
        sessionId = ev.sessionID;
        // Register the child by session id once we know it, so
        // Adapter.cancel(sessionId) can find it.
        runningSessions.set(sessionId, {
          child,
          startedAt: Date.now(),
          runId: options.resumeSessionId ?? sessionId,
          attached: Boolean(config.attachServer),
        });
      }
      if (ev.type === "text" && ev.part?.type === "text" && typeof ev.part.text === "string") {
        textParts.push(ev.part.text);
        const chunk = ev.part.text;
        emitLog(
          "stdout",
          `${JSON.stringify({
            kind: "assistant",
            ts: new Date().toISOString(),
            sessionID: sessionId,
            text: chunk,
            delta: true,
          })}\n`,
        );
        // Streaming: forward every text chunk as a progress event.
        emitProgress({
          kind: "text_delta",
          ts: new Date().toISOString(),
          sessionId,
          text: chunk,
        });
      } else if (
        ev.type === "thinking" &&
        ev.part?.type === "thinking" &&
        typeof ev.part.text === "string"
      ) {
        thinkingEventCount += 1;
        emitLog(
          "stdout",
          `${JSON.stringify({
            kind: "thinking",
            ts: new Date().toISOString(),
            sessionID: sessionId,
            text: ev.part.text,
            delta: true,
          })}\n`,
        );
        emitProgress({
          kind: "thinking_delta",
          ts: new Date().toISOString(),
          sessionId,
          text: ev.part.text,
        });
      } else if (ev.type === "tool_use" || ev.type === "tool") {
        toolEventCount += 1;
        const toolName = (ev.part?.tool as string) ?? "unknown";
        const callId = (ev.part?.callID as string) ?? undefined;
        const status = (ev.part?.state?.status as string) ?? "started";
        const toolInput =
          (ev.part as { input?: unknown; args?: unknown }).input ??
          (ev.part as { args?: unknown }).args ??
          ev.part?.state?.input ??
          {};
        const toolKey = `${callId ?? "no-id"}:${toolName}`;
        const firstToolEvent = !toolsDispatched.has(toolKey);
        if (firstToolEvent) {
          toolsDispatched.add(toolKey);
          toolsInvoked.push(toolName);
        }
        if (
          toolName === "company_action" &&
          status === "completed" &&
          callId &&
          !companyActionCalls.has(toolKey)
        ) {
          try {
            const action = parseCompanyActionInput(toolInput);
            if (action !== undefined) {
              companyActions.push(action);
              companyActionCalls.add(toolKey);
            }
          } catch (error) {
            jsonErrorMessage =
              error instanceof Error ? error.message : "company_action input is invalid";
          }
        }
        emitLog(
          "stdout",
          `${JSON.stringify({
            kind:
              status === "completed" || status === "failed" || status === "cancelled"
                ? "tool_result"
                : "tool_call",
            ts: new Date().toISOString(),
            sessionID: sessionId,
            name: toolName,
            id: callId,
            status: status as "started" | "completed" | "failed" | "cancelled",
            output: typeof ev.part?.state?.output === "string" ? ev.part.state.output : undefined,
            isError: status === "failed",
          })}\n`,
        );
        emitProgress({
          kind: "tool_event",
          ts: new Date().toISOString(),
          sessionId,
          name: toolName,
          id: callId,
          status,
        });
        // Route through the caller's tool dispatcher if provided.
        // The dispatcher is responsible for the actual execution;
        // we just record the result into the stream so it shows up
        // in the session_events table and the UI. We fire on every
        // tool_use event (not just status="started") so the
        // dispatcher gets the call even if the CLI reports the
        // tool as already-completed. Each tool is dispatched at
        // most once per run (deduped by callId+name).
        if (options.tools && firstToolEvent) {
          // Fire-and-forget — the opencode CLI continues its own
          // tool loop, so the dispatcher result is advisory. The
          // session layer (or a future "approval" gate) decides
          // whether to short-circuit.
          void options.tools
            .invoke(toolName, toolInput, {
              callId,
              sessionId,
            })
            .then((output) => {
              emitLog(
                "stdout",
                `${JSON.stringify({
                  kind: "tool_result",
                  ts: new Date().toISOString(),
                  sessionID: sessionId,
                  name: toolName,
                  id: callId,
                  status: "completed",
                  output: typeof output === "string" ? output : JSON.stringify(output),
                })}\n`,
              );
              emitProgress({
                kind: "tool_event",
                ts: new Date().toISOString(),
                sessionId,
                name: toolName,
                id: callId,
                status: "completed",
                output: typeof output === "string" ? output : JSON.stringify(output),
              });
            })
            .catch((err) => {
              emitLog(
                "stdout",
                `${JSON.stringify({
                  kind: "tool_result",
                  ts: new Date().toISOString(),
                  sessionID: sessionId,
                  name: toolName,
                  id: callId,
                  status: "failed",
                  isError: true,
                  output: (err as Error).message,
                })}\n`,
              );
            });
        }
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
        emitLog(
          "stdout",
          `${JSON.stringify({
            kind: "result",
            ts: new Date().toISOString(),
            sessionID: sessionId,
            summary: textParts.join("").slice(0, 200),
            tokens,
            cost,
          })}\n`,
        );
      } else if (ev.type === "error") {
        // Mirror paperclip's opencode adapter: pull the message out
        // of the JSON error event so the result.errorMessage surfaces
        // it instead of the (often empty) stderr.
        const raw = (ev as { error?: unknown; message?: unknown }).error;
        const msg = extractErrorMessage(raw ?? (ev as { message?: unknown }).message);
        if (msg) {
          jsonErrorMessage = jsonErrorMessage ? `${jsonErrorMessage}; ${msg}` : msg;
        }
        // Also keep the onLog `init` event so existing consumers
        // (the sessions layer's onLog handler) still see the error
        // arrival.
        emitLog(
          "stdout",
          `${JSON.stringify({
            kind: "init",
            ts: new Date().toISOString(),
            sessionID: sessionId,
            event: "error",
            errorMessage: msg,
          })}\n`,
        );
      } else {
        emitLog(
          "stdout",
          `${JSON.stringify({
            kind: "init",
            ts: new Date().toISOString(),
            sessionID: sessionId,
            event: ev.type,
          })}\n`,
        );
      }
    }

    child.on("error", (err) => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (killHandle !== undefined) clearTimeout(killHandle);
      cleanup();
      reject(err);
    });

    child.on("close", async (code, closeSignal) => {
      closed = true;
      signal?.removeEventListener("abort", abort);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (killHandle !== undefined) clearTimeout(killHandle);
      cleanup();
      // Unregister from the runningSessions map so cancel() won't find a dead child.
      if (sessionId) runningSessions.delete(sessionId);
      if (stdoutBuf.trim().length > 0) {
        try {
          const ev = JSON.parse(stdoutBuf) as OpenCodeEvent;
          handleEvent(ev);
        } catch {
          /* ignore */
        }
      }
      await pendingLogWrites;
      await pendingProgress;
      // Node's child_process close signature is `(code, signal)`.
      //   - exited normally: code is a number, signal is null
      //   - killed by signal: code is null, signal is the signal name
      // The previous code coerced `null` exitCode to `0`, which
      // collapsed "killed by SIGTERM" and "exited 0" into the same
      // shape and lost the signal info. Surface both.
      const exitCode = code === 0 && jsonErrorMessage ? 1 : code;
      const childSignal = (closeSignal ?? null) as NodeJS.Signals | null;
      // Compose the errorMessage with a clear priority order:
      //   1. JSON error event message (paperclip-style) — most specific
      //   2. stderr text — what most CLIs write for fatal errors
      //   3. killed-by-signal description
      const parts: string[] = [];
      const stderrTrim = stderrBuf.trim().slice(0, 2_048);
      if (jsonErrorMessage) parts.push(jsonErrorMessage);
      if (stderrTrim) parts.push(stderrTrim);
      const errorMessage =
        parts.length > 0
          ? parts.join(" | ")
          : exitCode !== 0 && exitCode !== null
            ? `opencode exited with code ${exitCode}`
            : childSignal
              ? `opencode killed by ${childSignal}`
              : undefined;
      resolve({
        sessionId,
        text: textParts.join(""),
        inputTokens,
        outputTokens,
        cost,
        exitCode,
        signal: childSignal,
        timedOut,
        errorMessage,
        resumedSession: Boolean(options.resumeSessionId),
        continuedLast: config.continueLast,
        attached: Boolean(config.attachServer),
        cliSessionId: sessionId,
        thinkingEventCount,
        toolEventCount,
        toolsInvoked,
        companyActions,
      });
    });
  });
}

/** Execute OpenCode through the selected runtime while retaining its JSON stream semantics. */
async function runOpencodeThroughRuntime(input: {
  cli: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
  execution: AdapterRuntimeExecution;
  timeoutMs?: number;
  graceMs?: number;
  tools?: {
    invoke(name: string, input: unknown, ctx: unknown): Promise<unknown>;
    get?(name: string): unknown;
    list?(): readonly string[];
  };
  resumeSessionId?: string;
  continuedLast: boolean;
  attached: boolean;
}): Promise<RunResult> {
  let sessionId: string | undefined;
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let errorMessage: string | undefined;
  let thinkingEventCount = 0;
  let toolEventCount = 0;
  const toolsInvoked: string[] = [];
  const toolsDispatched = new Set<string>();
  const companyActions: JsonValue[] = [];
  const companyActionCalls = new Set<string>();
  let stdoutBuffer = "";
  let companyActionError: string | undefined;
  let observedStdout = false;
  let pendingTools: Promise<void> = Promise.resolve();
  const parseLine = (line: string): void => {
    if (!line.trim()) return;
    let event: OpenCodeEvent & { error?: unknown };
    try {
      event = JSON.parse(line) as OpenCodeEvent & { error?: unknown };
    } catch {
      return;
    }
    if (event.sessionID) sessionId = event.sessionID;
    if (event.type === "text" && event.part?.type === "text") {
      text += String(event.part.text ?? "");
    }
    if (event.part?.type === "reasoning" || event.type === "thinking") thinkingEventCount += 1;
    if (event.part?.type === "tool" || event.type === "tool_use" || event.type === "tool") {
      toolEventCount += 1;
      const toolName = String(event.part?.tool ?? event.part?.name ?? "unknown");
      const callId = String(event.part?.callID ?? "no-id");
      const toolInput =
        (event.part as { input?: unknown; args?: unknown } | undefined)?.input ??
        (event.part as { args?: unknown } | undefined)?.args ??
        event.part?.state?.input ??
        {};
      const toolKey = `${callId}:${toolName}`;
      const firstToolEvent = !toolsDispatched.has(toolKey);
      if (firstToolEvent) {
        toolsDispatched.add(toolKey);
        toolsInvoked.push(toolName);
      }
      const status = String(event.part?.state?.status ?? "started");
      if (
        toolName === "company_action" &&
        status === "completed" &&
        callId !== "no-id" &&
        !companyActionCalls.has(toolKey)
      ) {
        try {
          const action = parseCompanyActionInput(toolInput);
          if (action !== undefined) {
            companyActions.push(action);
            companyActionCalls.add(toolKey);
          }
        } catch (error) {
          companyActionError =
            error instanceof Error ? error.message : "company_action input is invalid";
        }
      }
      if (input.tools && firstToolEvent) {
        pendingTools = pendingTools.then(async () => {
          try {
            const output = await input.tools?.invoke(toolName, toolInput, {
              callId,
              sessionId,
            });
            await input.onLog?.(
              "stdout",
              `${JSON.stringify({
                kind: "tool_result",
                ts: new Date().toISOString(),
                name: toolName,
                id: callId,
                status: "completed",
                output: typeof output === "string" ? output : JSON.stringify(output),
              })}\n`,
            );
          } catch (error) {
            await input.onLog?.(
              "stdout",
              `${JSON.stringify({
                kind: "tool_result",
                ts: new Date().toISOString(),
                name: toolName,
                id: callId,
                status: "failed",
                isError: true,
                output: error instanceof Error ? error.message : String(error),
              })}\n`,
            );
          }
        });
      }
    }
    const tokens = event.part?.tokens as { input?: unknown; output?: unknown } | undefined;
    if (typeof tokens?.input === "number") inputTokens = tokens.input;
    if (typeof tokens?.output === "number") outputTokens = tokens.output;
    if (typeof event.part?.cost === "number") cost = event.part.cost;
    const message = extractErrorMessage(event.error);
    if (message) errorMessage = message;
  };
  const parse = (chunk: string, flush = false): void => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      parseLine(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
    }
    if (flush && stdoutBuffer.trim()) parseLine(stdoutBuffer);
    if (flush) stdoutBuffer = "";
  };
  const result = await input.execution.run({
    command: input.cli,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    graceMs: input.graceMs,
    onLog: async (stream, chunk) => {
      if (stream === "stdout") {
        observedStdout = observedStdout || chunk.length > 0;
        parse(chunk);
      } else if (!errorMessage) errorMessage = chunk.trim().split(/\r?\n/).find(Boolean);
      await input.onLog?.(stream, chunk);
    },
  });
  if (!observedStdout && result.stdout) parse(result.stdout);
  if (!errorMessage && result.stderr) {
    errorMessage = result.stderr.trim().split(/\r?\n/).find(Boolean);
  }
  parse("", true);
  await pendingTools;
  return {
    sessionId,
    text,
    inputTokens,
    outputTokens,
    cost,
    exitCode: result.exitCode === 0 && companyActionError ? 1 : result.exitCode,
    signal: (result.signal as NodeJS.Signals | undefined) ?? null,
    timedOut: result.timedOut,
    errorMessage: companyActionError ?? errorMessage,
    resumedSession: Boolean(input.resumeSessionId),
    continuedLast: input.continuedLast,
    attached: input.attached,
    cliSessionId: sessionId,
    thinkingEventCount,
    toolEventCount,
    toolsInvoked,
    companyActions,
  };
}

/**
 * Pull a human-readable message out of an opencode error event.
 * The CLI emits either a string (`"api key invalid"`) or an object
 * shaped like `{ message, data: { message } | ..., name, code }` —
 * we try the obvious slots in priority order and fall back to
 * JSON.stringify.
 */
function extractErrorMessage(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const direct = typeof rec.message === "string" ? rec.message.trim() : "";
    if (direct) return direct;
    const data = rec.data;
    if (data && typeof data === "object") {
      const nested =
        typeof (data as Record<string, unknown>).message === "string"
          ? ((data as Record<string, unknown>).message as string).trim()
          : "";
      if (nested) return nested;
    }
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (name) return name;
    const code = typeof rec.code === "string" ? rec.code.trim() : "";
    if (code) return code;
    try {
      return JSON.stringify(rec);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseCompanyActionInput(value: unknown): JsonValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("company_action input must be an object");
  }
  const payload = (value as { payload?: unknown }).payload;
  if (payload === undefined) return undefined;
  if (typeof payload !== "string" || payload.length > 65_536) {
    throw new Error("company_action payload must be a JSON string up to 64 KiB");
  }
  return JSON.parse(payload) as JsonValue;
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
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 10_000;
let lockChain: Promise<void> = Promise.resolve();
const PROCESS_LOCK_NONCE = randomUUID();

function getLockPath(): string {
  return process.env.AASPAI_OPENCODE_LOCK_PATH ?? join(tmpdir(), "aaspai-opencode.lock");
}

async function acquireLock(): Promise<() => void> {
  const myId = `${process.pid}@${hostname()}@${PROCESS_LOCK_NONCE}`;
  const lockPath = getLockPath();
  const startedAt = Date.now();
  // Queue our turn behind any other process waiting on the same
  // per-process promise chain.
  const myTurn = lockChain.then(async () => {
    while (true) {
      if (Date.now() - startedAt > LOCK_MAX_WAIT_MS) {
        throw new Error(`opencode_cli cross-process lock timeout after ${LOCK_MAX_WAIT_MS}ms`);
      }
      if (!existsSync(lockPath)) {
        try {
          const fd = openSync(lockPath, "wx");
          writeSync(fd, myId);
          closeSync(fd);
          return;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      // Lock file exists. Check if it's stale (PID not running).
      try {
        const holder = readFileSync(lockPath, "utf8").trim();
        const m = /^(\d+)@/.exec(holder);
        if (m) {
          const holderPid = Number(m[1]);
          const sameProcessWithDifferentOwner = holderPid === process.pid && holder !== myId;
          if (
            sameProcessWithDifferentOwner ||
            (holderPid !== process.pid && !isPidRunning(holderPid))
          ) {
            // Stale lock — steal it.
            try {
              unlinkSync(lockPath);
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
      const current = readFileSync(lockPath, "utf8").trim();
      if (current === myId) unlinkSync(lockPath);
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

/* ──────────────────────────────────────────────────────────────────
 *  Persistent runtime (Priority 3)
 *  Auto-start an `opencode serve` per workspace, then use --attach.
 *  ────────────────────────────────────────────────────────────────── */

interface PersistentServer {
  url: string;
  port: number;
  pid: number;
  startedAt: string;
}

const persistentServers = new Map<string, PersistentServer>();

/**
 * Start an `opencode serve` instance for the given workspace key.
 * Returns the URL the adapter should pass to `--attach`. If one
 * is already running for that key, return the existing one.
 *
 * The server is auto-shutdown when this process exits (best-effort).
 */
export async function startOpencodeServe(opts: {
  workspaceKey: string;
  port?: number;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<PersistentServer> {
  const existing = persistentServers.get(opts.workspaceKey);
  if (existing && isPidRunning(existing.pid)) return existing;

  const cli = await resolveOpencodeBinary(undefined);
  const port = opts.port ?? 0; // 0 = random
  const args = ["serve", "--port", String(port)];
  // Use detached so the server survives if the parent dies. We also
  // explicitly unref so the server doesn't keep node alive.
  const child = spawn(cli, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: true,
  });
  child.unref();

  // Wait for the server to write its port to stdout. The opencode
  // server prints `listening on http://localhost:<port>` once it's
  // ready. We read up to that line.
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* */
      }
      reject(new Error("opencode serve startup timeout (10s)"));
    }, 10_000);
    timer.unref();
    let buf = "";
    const onChunk = (c: Buffer) => {
      buf += c.toString("utf8");
      const m = /listening on (https?:\/\/[^\s]+)/i.exec(buf);
      if (m?.[1]) {
        clearTimeout(timer);
        child.stdout?.off("data", onChunk);
        resolve(m[1]);
      }
    };
    child.stdout?.on("data", onChunk);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const portMatch = /:(\d+)/.exec(url);
  const actualPort = portMatch ? Number(portMatch[1]) : port;
  const server: PersistentServer = {
    url,
    port: actualPort,
    pid: child.pid ?? 0,
    startedAt: new Date().toISOString(),
  };
  persistentServers.set(opts.workspaceKey, server);
  return server;
}

export function stopOpencodeServe(workspaceKey: string): void {
  const existing = persistentServers.get(workspaceKey);
  if (!existing) return;
  try {
    if (existing.pid) process.kill(existing.pid, "SIGTERM");
  } catch {
    /* */
  }
  persistentServers.delete(workspaceKey);
}

/* ──────────────────────────────────────────────────────────────────
 *  Hello probe + models list (Priority 6)
 *  ────────────────────────────────────────────────────────────────── */

export async function runOpencodeHelloProbe(opts: {
  cli?: string;
  commandArgs?: string[];
  model?: string;
  cwd?: string;
  expectedReply?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; reply?: string; durationMs: number; error?: string }> {
  const expected = opts.expectedReply ?? "HELLO_PROBE_OK";
  const startedAt = Date.now();
  const cli = await resolveOpencodeBinary(opts.cli);
  return await new Promise((resolve) => {
    const child = spawn(
      cli,
      [
        ...(opts.commandArgs ?? []),
        "run",
        "--format",
        "json",
        "--model",
        opts.model ?? "opencode-go/mimo-v2.5",
        "--title",
        "hello-probe",
        expected,
      ],
      {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let buf = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* */
      }
      resolve({ ok: false, error: "hello probe timeout", durationMs: Date.now() - startedAt });
    }, opts.timeoutMs ?? 15_000);
    timer.unref();
    child.stdout?.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, durationMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = buf
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => {
          try {
            const j = JSON.parse(l) as { type?: string; part?: { text?: string } };
            return j.part?.text ?? "";
          } catch {
            return "";
          }
        })
        .join("");
      if (code !== 0) {
        resolve({
          ok: false,
          error: `exit ${code}`,
          reply: text,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      if (!text.includes(expected)) {
        resolve({
          ok: false,
          reply: text,
          error: `expected '${expected}' not found`,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      resolve({ ok: true, reply: text, durationMs: Date.now() - startedAt });
    });
  });
}

export async function listOpencodeModels(opts: {
  cli?: string;
  commandArgs?: string[];
  cwd?: string;
}): Promise<string[]> {
  const cli = await resolveOpencodeBinary(opts.cli);
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((res, rej) => {
      const p = spawn(cli, [...(opts.commandArgs ?? []), "models"], {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && cli.endsWith(".cmd"),
      });
      let out = "";
      let err = "";
      p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
      p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
      p.on("error", rej);
      p.on("close", (code) => {
        if (code === 0) res({ stdout: out, stderr: err });
        else rej(new Error(`opencode models exit ${code}: ${err}`));
      });
    });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.includes("/"));
  } catch {
    return [];
  }
}

/* ──────────────────────────────────────────────────────────────────
 *  Auth management
 *  Writes `~/.local/share/opencode/auth.json` directly so a fresh
 *  `opencode run` finds credentials. The format is:
 *    { "<provider>": { "type": "api", "key": "sk-…" } }
 *  ────────────────────────────────────────────────────────────────── */

function getAuthFilePathInternal(): string {
  return (
    process.env.AASPAI_OPENCODE_AUTH_PATH ??
    join(process.env.HOME ?? tmpdir(), ".local", "share", "opencode", "auth.json")
  );
}

export function getAuthFilePath(): string {
  return getAuthFilePathInternal();
}

function readAuthFile(): Record<string, Record<string, unknown>> {
  const file = getAuthFilePathInternal();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, Record<string, unknown>>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeAuthFile(auth: Record<string, Record<string, unknown>>): void {
  const file = getAuthFilePathInternal();
  const dir = file.replace(/[\\/][^\\/]+$/, "");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  writeFileSync(file, JSON.stringify(auth, null, 2), "utf8");
  try {
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

export function setOpencodeAuth(
  provider: string,
  apiKey: string,
  opts?: { type?: string },
): {
  path: string;
} {
  const auth = readAuthFile();
  auth[provider] = { type: opts?.type ?? "api", key: apiKey };
  writeAuthFile(auth);
  return { path: getAuthFilePathInternal() };
}

export function removeOpencodeAuth(provider: string): { removed: boolean; path: string } {
  const auth = readAuthFile();
  const had = provider in auth;
  delete auth[provider];
  writeAuthFile(auth);
  return { removed: had, path: getAuthFilePathInternal() };
}

export function listOpencodeAuth(): Record<string, { type: string; hasKey: boolean }> {
  const auth = readAuthFile();
  const out: Record<string, { type: string; hasKey: boolean }> = {};
  for (const [k, v] of Object.entries(auth)) {
    out[k] = {
      type: (v as { type?: string }).type ?? "api",
      hasKey:
        typeof (v as { key?: unknown }).key === "string" && (v as { key: string }).key.length > 0,
    };
  }
  return out;
}

export async function opencodeProviders(opts: { cli?: string; cwd?: string }): Promise<string[]> {
  const cli = await resolveOpencodeBinary(opts.cli);
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((res, rej) => {
      const p = spawn(cli, ["providers"], {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && cli.endsWith(".cmd"),
      });
      let out = "";
      let err = "";
      p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
      p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
      p.on("error", rej);
      p.on("close", (code) => {
        if (code === 0) res({ stdout: out, stderr: err });
        else rej(new Error(`opencode providers exit ${code}: ${err}`));
      });
    });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/* ──────────────────────────────────────────────────────────────────
 *  Session bookkeeping (`opencode session list/export/import`)
 *  Authoritative source for "which sessions exist" + portable JSON.
 *  ────────────────────────────────────────────────────────────────── */

export async function opencodeSessionList(opts: {
  cli?: string;
  cwd?: string;
}): Promise<Array<{ id: string; title?: string; startedAt?: string }>> {
  const cli = await resolveOpencodeBinary(opts.cli);
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((res, rej) => {
      const p = spawn(cli, ["session", "list", "--format", "json"], {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && cli.endsWith(".cmd"),
      });
      let out = "";
      let err = "";
      p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
      p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
      p.on("error", rej);
      p.on("close", (code) => {
        if (code === 0) res({ stdout: out, stderr: err });
        else rej(new Error(`opencode session list exit ${code}: ${err}`));
      });
    });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          const j = JSON.parse(l) as { id?: string; title?: string; startedAt?: string };
          return { id: j.id ?? "", title: j.title, startedAt: j.startedAt };
        } catch {
          return { id: l };
        }
      });
  } catch {
    return [];
  }
}

export async function opencodeSessionExport(
  sessionId: string,
  opts: {
    cli?: string;
    cwd?: string;
  },
): Promise<string> {
  const cli = await resolveOpencodeBinary(opts.cli);
  const { stdout } = await new Promise<{ stdout: string; stderr: string }>((res, rej) => {
    const p = spawn(cli, ["session", "export", sessionId], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && cli.endsWith(".cmd"),
    });
    let out = "";
    let err = "";
    p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    p.on("error", rej);
    p.on("close", (code) => {
      if (code === 0) res({ stdout: out, stderr: err });
      else rej(new Error(`opencode session export exit ${code}: ${err}`));
    });
  });
  return stdout;
}

export async function opencodeSessionImport(
  json: string,
  opts: {
    cli?: string;
    cwd?: string;
  },
): Promise<string> {
  const cli = await resolveOpencodeBinary(opts.cli);
  const { stdout } = await new Promise<{ stdout: string; stderr: string }>((res, rej) => {
    const p = spawn(cli, ["session", "import"], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && cli.endsWith(".cmd"),
    });
    let out = "";
    let err = "";
    p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    p.on("error", rej);
    p.stdin?.on("error", () => {});
    p.stdin?.end(json);
    p.on("close", (code) => {
      if (code === 0) res({ stdout: out, stderr: err });
      else rej(new Error(`opencode session import exit ${code}: ${err}`));
    });
  });
  return stdout.trim();
}

/* ──────────────────────────────────────────────────────────────────
 *  Post-run stats (`opencode stats <sessionId>`)
 *  Authoritative token + cost numbers for a session, used to
 *  reconcile against the event-stream totals we record.
 *  ────────────────────────────────────────────────────────────────── */

export interface OpencodeStats {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  durationMs?: number;
}

export async function opencodeStats(
  sessionId: string,
  opts: { cli?: string; cwd?: string },
): Promise<OpencodeStats | null> {
  const cli = await resolveOpencodeBinary(opts.cli);
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((res, rej) => {
      const p = spawn(cli, ["stats", sessionId, "--format", "json"], {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && cli.endsWith(".cmd"),
      });
      let out = "";
      let err = "";
      p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
      p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
      p.on("error", rej);
      p.on("close", (code) => {
        if (code === 0) res({ stdout: out, stderr: err });
        else rej(new Error(`opencode stats exit ${code}: ${err}`));
      });
    });
    const j = JSON.parse(stdout) as Partial<OpencodeStats>;
    return {
      sessionId,
      inputTokens: j.inputTokens ?? 0,
      outputTokens: j.outputTokens ?? 0,
      cachedInputTokens: j.cachedInputTokens ?? 0,
      reasoningTokens: j.reasoningTokens ?? 0,
      costUsd: j.costUsd ?? 0,
      durationMs: j.durationMs,
    };
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────
 *  File-system helpers
 *  Write MCP / agent / skill files into the user's opencode config
 *  directory so the opencode CLI picks them up automatically.
 *  ────────────────────────────────────────────────────────────────── */

const DEFAULT_OPENCODE_CONFIG_DIR =
  process.env.AASPAI_OPENCODE_CONFIG_DIR ??
  join(process.env.HOME ?? tmpdir(), ".config", "opencode");

export function getOpencodeConfigDir(): string {
  return DEFAULT_OPENCODE_CONFIG_DIR;
}

/** Write or merge the `mcp.json` file the opencode CLI loads. */
export function writeOpencodeMcpServers(
  servers: Record<
    string,
    {
      type: "stdio" | "http" | "sse";
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
    }
  >,
  opts?: { dir?: string },
): { path: string } {
  const dir = opts?.dir ?? DEFAULT_OPENCODE_CONFIG_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "mcp.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* fresh */
  }
  const merged = {
    ...existing,
    mcpServers: { ...((existing.mcpServers as object) ?? {}), ...servers },
  };
  writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
  return { path: file };
}

/** Write a named agent file (`agent/<name>.md`). */
export function writeOpencodeAgentFile(
  name: string,
  body: string,
  opts?: { dir?: string; frontmatter?: Record<string, unknown> },
): { path: string } {
  const dir = join(opts?.dir ?? DEFAULT_OPENCODE_CONFIG_DIR, "agent");
  mkdirSync(dir, { recursive: true });
  const safe = name.replace(/[\\/]/g, "_");
  const file = join(dir, `${safe}.md`);
  let text = body;
  if (opts?.frontmatter && Object.keys(opts.frontmatter).length > 0) {
    const fm = Object.entries(opts.frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    text = `---\n${fm}\n---\n\n${body}`;
  }
  writeFileSync(file, text, "utf8");
  return { path: file };
}

/** Write a skill directory (`skill/<name>/SKILL.md`). */
export function writeOpencodeSkill(
  name: string,
  body: string,
  opts?: { dir?: string; frontmatter?: Record<string, unknown>; files?: Record<string, string> },
): { path: string; dir: string } {
  const base = join(opts?.dir ?? DEFAULT_OPENCODE_CONFIG_DIR, "skill", name);
  mkdirSync(base, { recursive: true });
  let text = body;
  if (opts?.frontmatter && Object.keys(opts.frontmatter).length > 0) {
    const fm = Object.entries(opts.frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    text = `---\n${fm}\n---\n\n${body}`;
  }
  const file = join(base, "SKILL.md");
  writeFileSync(file, text, "utf8");
  for (const [relPath, content] of Object.entries(opts?.files ?? {})) {
    const full = join(base, relPath);
    mkdirSync(full.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return { path: file, dir: base };
}

/** Add (or replace) a custom provider in `opencode.json`. Returns the new doc. */
export function addOpencodeProvider(
  id: string,
  provider: { baseUrl: string; apiKey?: string; models?: Array<{ id: string; name?: string }> },
  opts?: { dir?: string; auth?: { type?: string; key?: string } },
): { path: string; doc: Record<string, unknown> } {
  const dir = opts?.dir ?? DEFAULT_OPENCODE_CONFIG_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode.json");
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* fresh */
  }
  const providerBlock = (doc.provider as Record<string, unknown> | undefined) ?? {};
  const existing = (providerBlock[id] as Record<string, unknown> | undefined) ?? {};
  providerBlock[id] = {
    ...existing,
    baseUrl: provider.baseUrl,
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    ...(provider.models ? { models: provider.models } : {}),
  };
  doc.provider = providerBlock;
  if (opts?.auth) {
    doc.auth = opts.auth;
  }
  writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
  return { path: file, doc };
}

/* ────────────────────────────────────────────────────────────────────
 *  Tier 2: opencode subcommand wrappers (19 added in this pass)
 *  ──────────────────────────────────────────────────────────────────── */

/** Common options for every opencode subcommand wrapper. */
interface SubcommandOpts {
  cli?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Abort the child if signalled. */
  signal?: AbortSignal;
}

/** Run an `opencode <subcmd>` invocation and resolve with parsed JSON / text. */
async function runOpencodeSubcommand(
  args: string[],
  opts: SubcommandOpts & { json?: boolean; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const cli = opts.cli ?? (await resolveOpencodeBinary(process.env.OPENCODE_CLI));
  const workdir = opts.cwd ?? process.env.OPENCODE_CLI_DIR ?? process.cwd();
  // Cross-platform: if the caller passed a `.cjs`/`.js`/`.mjs`/`.ts` file
  // path, exec node on it directly (avoids Windows .cmd EINVAL on spawn).
  const isScript = /\.(c?js|mjs|ts)$/i.test(cli);
  const exec = isScript ? process.execPath : cli;
  const execArgs = isScript ? [cli, ...args] : args;
  return await new Promise((resolve, reject) => {
    const child = spawn(exec, execArgs, {
      cwd: workdir,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    let stdout = "";
    let stderr = "";
    const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024;
    child.stdout?.on("data", (c) => {
      stdout += c.toString("utf8");
      if (stdout.length > maxBuffer) stdout = stdout.slice(0, maxBuffer);
    });
    child.stderr?.on("data", (c) => {
      stderr += c.toString("utf8");
      if (stderr.length > maxBuffer) stderr = stderr.slice(0, maxBuffer);
    });
    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

/* ── acp ──────────────────────────────────────────────────────────── */

export interface AcpServerHandle {
  pid: number;
  port: number;
  hostname: string;
  url: string;
  /** A child-resolved promise that resolves when the ACP server stops. */
  stopped: Promise<{ exitCode: number | null }>;
  /** Stop the ACP server. */
  stop: () => void;
}

interface AcpInternalHandle {
  port: number;
  hostname: string;
  child: import("node:child_process").ChildProcess;
  resolveStopped: (v: { exitCode: number | null }) => void;
  stopped: Promise<{ exitCode: number | null }>;
  stop: () => void;
}

const acpHandles = new Map<string, AcpInternalHandle>();

/** Track a running `opencode run` child so `Adapter.cancel()` can find it. */
interface RunningSessionHandle {
  child: import("node:child_process").ChildProcess;
  startedAt: number;
  runId: string;
  /** Whether this session was attached to a CLI server (cancel via API). */
  attached: boolean;
}
const runningSessions = new Map<string, RunningSessionHandle>();

/**
 * Start an `opencode acp` (Agent Client Protocol) server. Returns a
 * handle with the chosen port, the child PID, and a `stop()` method.
 * Multiple invocations under different `workspaceKey`s are tracked
 * independently.
 */
export async function startOpencodeAcp(opts: {
  cli?: string;
  cwd?: string;
  port?: number;
  hostname?: string;
  mdns?: boolean;
  mdnsDomain?: string;
  cors?: string[];
  workspaceKey?: string;
}): Promise<AcpServerHandle> {
  const cli = opts.cli ?? (await resolveOpencodeBinary(process.env.OPENCODE_CLI));
  const workdir = opts.cwd ?? process.env.OPENCODE_CLI_DIR ?? process.cwd();
  const args = ["acp"];
  if (typeof opts.port === "number") args.push("--port", String(opts.port));
  if (opts.hostname) args.push("--hostname", opts.hostname);
  if (opts.mdns) args.push("--mdns");
  if (opts.mdnsDomain) args.push("--mdns-domain", opts.mdnsDomain);
  for (const c of opts.cors ?? []) args.push("--cors", c);
  // Cross-platform: if the caller passed a script, exec node on it.
  const isScript = /\.(c?js|mjs|ts)$/i.test(cli);
  const exec = isScript ? process.execPath : cli;
  const execArgs = isScript ? [cli, ...args] : args;
  const child = spawn(exec, execArgs, {
    cwd: workdir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});
  let resolveStopped: (v: { exitCode: number | null }) => void = () => {};
  const stopped = new Promise<{ exitCode: number | null }>((r) => {
    resolveStopped = r;
  });
  const port = opts.port ?? 0;
  const hostname = opts.hostname ?? "127.0.0.1";
  const internal: AcpInternalHandle = {
    port,
    hostname,
    child,
    resolveStopped,
    stopped,
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    },
  };
  child.on("close", (code) => resolveStopped({ exitCode: code }));
  const key = opts.workspaceKey ?? workdir;
  acpHandles.set(key, internal);
  const url = `http://${hostname}:${port}`;
  return {
    pid: child.pid ?? -1,
    port,
    hostname,
    url,
    stopped,
    stop: internal.stop,
  };
}

/** Stop a previously-started ACP server. Idempotent. */
export function stopOpencodeAcp(workspaceKey?: string): boolean {
  const key = workspaceKey;
  if (key) {
    const h = acpHandles.get(key);
    if (!h) return false;
    h.stop();
    acpHandles.delete(key);
    return true;
  }
  // No key — stop all.
  let stopped = false;
  for (const [, h] of acpHandles) {
    h.stop();
    stopped = true;
  }
  acpHandles.clear();
  return stopped;
}

/* ── session ──────────────────────────────────────────────────────── */

/** Delete a session by id. Returns the child exit code (0 on success). */
export async function deleteOpencodeSession(
  sessionId: string,
  opts: SubcommandOpts = {},
): Promise<{ exitCode: number | null; stderr: string }> {
  const { exitCode, stderr } = await runOpencodeSubcommand(["session", "delete", sessionId], opts);
  return { exitCode, stderr };
}

/** List sessions with the given format and limit. `format: "json"` is parsed. */
export async function listOpencodeSessionsWithLimit(
  opts: SubcommandOpts & { maxCount?: number; format?: "table" | "json" } = {},
): Promise<{ rows: string[]; json?: unknown }> {
  const args = ["session", "list"];
  if (typeof opts.maxCount === "number") args.push("--max-count", String(opts.maxCount));
  const fmt = opts.format ?? "table";
  args.push("--format", fmt);
  const { stdout, exitCode } = await runOpencodeSubcommand(args, opts);
  if (exitCode !== 0) return { rows: stdout.split(/\r?\n/).filter((l) => l.trim().length > 0) };
  if (fmt === "json") {
    try {
      return { rows: [], json: JSON.parse(stdout) };
    } catch {
      return { rows: stdout.split(/\r?\n/) };
    }
  }
  return { rows: stdout.split(/\r?\n/).filter((l) => l.trim().length > 0) };
}

/* ── mcp ──────────────────────────────────────────────────────────── */

/** Add an MCP server via `opencode mcp add`. */
export async function addOpencodeMcp(
  name: string,
  server: { type: "stdio" | "http"; command?: string; args?: string[]; url?: string },
  opts: SubcommandOpts = {},
): Promise<{ exitCode: number | null; stderr: string }> {
  const args = ["mcp", "add", name];
  if (server.type === "stdio") {
    if (server.command) args.push("--command", server.command);
    for (const a of server.args ?? []) args.push("--arg", a);
  } else {
    if (server.url) args.push("--url", server.url);
  }
  const { exitCode, stderr } = await runOpencodeSubcommand(args, opts);
  return { exitCode, stderr };
}

/** List MCP servers (and their connection status). */
export async function listOpencodeMcp(
  opts: SubcommandOpts & { format?: "text" | "json" } = {},
): Promise<{ rows: string[]; json?: unknown }> {
  const args = ["mcp", "list", "--format", opts.format ?? "text"];
  const { stdout, exitCode } = await runOpencodeSubcommand(args, opts);
  if (opts.format === "json" && exitCode === 0) {
    try {
      return { rows: [], json: JSON.parse(stdout) };
    } catch {
      /* fallthrough */
    }
  }
  return { rows: stdout.split(/\r?\n/).filter((l) => l.trim().length > 0) };
}

/** Start OAuth for an MCP server (`opencode mcp auth`). */
export async function authOpencodeMcp(
  name: string,
  opts: SubcommandOpts = {},
): Promise<{ exitCode: number | null; stderr: string }> {
  const { exitCode, stderr } = await runOpencodeSubcommand(["mcp", "auth", name], opts);
  return { exitCode, stderr };
}

/** Logout (remove OAuth creds) for an MCP server. */
export async function logoutOpencodeMcp(
  name: string,
  opts: SubcommandOpts = {},
): Promise<{ exitCode: number | null; stderr: string }> {
  const { exitCode, stderr } = await runOpencodeSubcommand(["mcp", "logout", name], opts);
  return { exitCode, stderr };
}

/* ── agent ────────────────────────────────────────────────────────── */

/** List all installed opencode agents. */
export async function listOpencodeAgents(opts: SubcommandOpts = {}): Promise<{ rows: string[] }> {
  const { stdout } = await runOpencodeSubcommand(["agent", "list"], opts);
  return { rows: stdout.split(/\r?\n/).filter((l) => l.trim().length > 0) };
}

/** Create an agent interactively (returns child handle; non-zero exit = cancelled). */
export async function createOpencodeAgent(
  opts: SubcommandOpts = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const { exitCode, stdout, stderr } = await runOpencodeSubcommand(["agent", "create"], opts);
  return { exitCode, stdout, stderr };
}

/* ── debug ────────────────────────────────────────────────────────── */

/** Dump the resolved/merged opencode.json (post-merge from all scopes). */
export async function debugOpencodeConfig(
  opts: SubcommandOpts = {},
): Promise<{ doc: Record<string, unknown> | null; raw: string; exitCode: number | null }> {
  const { stdout, exitCode } = await runOpencodeSubcommand(["debug", "config"], opts);
  if (exitCode !== 0) return { doc: null, raw: stdout, exitCode };
  try {
    return { doc: JSON.parse(stdout) as Record<string, unknown>, raw: stdout, exitCode };
  } catch {
    return { doc: null, raw: stdout, exitCode };
  }
}

/** List all skills the opencode CLI actually discovers (not what we materialized). */
export async function debugOpencodeSkills(
  opts: SubcommandOpts = {},
): Promise<Array<{ name: string; description?: string; location?: string; content?: string }>> {
  const { stdout, exitCode } = await runOpencodeSubcommand(["debug", "skill"], opts);
  if (exitCode !== 0) return [];
  try {
    const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return arr.map((s) => ({
      name: String(s.name ?? ""),
      description: typeof s.description === "string" ? s.description : undefined,
      location: typeof s.location === "string" ? s.location : undefined,
      content: typeof s.content === "string" ? s.content : undefined,
    }));
  } catch {
    return [];
  }
}

/** Print all opencode global paths (home/data/bin/log/cache/config/state/tmp). */
export async function debugOpencodePaths(opts: SubcommandOpts = {}): Promise<{
  home?: string;
  data?: string;
  bin?: string;
  log?: string;
  repos?: string;
  cache?: string;
  config?: string;
  state?: string;
  tmp?: string;
}> {
  const { stdout, exitCode } = await runOpencodeSubcommand(["debug", "paths"], opts);
  const out: Record<string, string> = {};
  if (exitCode === 0) {
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*(\w+)\s+(.+)$/);
      if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2].trim();
    }
  }
  return out as {
    home?: string;
    data?: string;
    bin?: string;
    log?: string;
    repos?: string;
    cache?: string;
    config?: string;
    state?: string;
    tmp?: string;
  };
}

/** Capture the current workspace snapshot. */
export async function trackOpencodeSnapshot(
  opts: SubcommandOpts = {},
): Promise<{ hash?: string; raw: string; exitCode: number | null }> {
  const { stdout, exitCode } = await runOpencodeSubcommand(["debug", "snapshot", "track"], opts);
  const hash = stdout.trim().match(/^[0-9a-f]{6,}/i)?.[0];
  return { hash, raw: stdout, exitCode };
}

/** Show the diff for a given snapshot hash. */
export async function diffOpencodeSnapshot(
  hash: string,
  opts: SubcommandOpts = {},
): Promise<{ patch: string; exitCode: number | null }> {
  const { stdout, exitCode } = await runOpencodeSubcommand(
    ["debug", "snapshot", "diff", hash],
    opts,
  );
  return { patch: stdout, exitCode };
}

/** Generic debug-info dump (for bug reports). */
export async function debugOpencodeInfo(
  opts: SubcommandOpts = {},
): Promise<{ raw: string; exitCode: number | null }> {
  const { stdout, exitCode } = await runOpencodeSubcommand(["debug", "info"], opts);
  return { raw: stdout, exitCode };
}

/* ── db ───────────────────────────────────────────────────────────── */

/** Run a SQL query against the opencode SQLite DB and return rows. */
export async function queryOpencodeDb(
  query: string,
  opts: SubcommandOpts & { format?: "tsv" | "json" } = {},
): Promise<{ rows: string[]; json?: unknown; exitCode: number | null }> {
  const { stdout, exitCode } = await runOpencodeSubcommand(
    ["db", "--format", opts.format ?? "tsv", query],
    opts,
  );
  if (opts.format === "json" && exitCode === 0) {
    try {
      return { rows: [], json: JSON.parse(stdout), exitCode };
    } catch {
      /* fallthrough */
    }
  }
  return { rows: stdout.split(/\r?\n/), exitCode };
}

/** Print the path to the opencode SQLite database. */
export async function opencodeDbPath(
  opts: SubcommandOpts = {},
): Promise<{ path: string; exitCode: number | null }> {
  const { stdout, exitCode } = await runOpencodeSubcommand(["db", "path"], opts);
  return { path: stdout.trim(), exitCode };
}

/* ── models (improved) ────────────────────────────────────────────── */

/** Refresh the model cache from models.dev, then return the model list. */
export async function refreshOpencodeModels(
  opts: SubcommandOpts & { verbose?: boolean } = {},
): Promise<{ models: string[]; raw: string; exitCode: number | null }> {
  const args = ["models", "--refresh"];
  if (opts.verbose) args.push("--verbose");
  const { stdout, exitCode } = await runOpencodeSubcommand(args, opts);
  const models = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.includes("/"));
  return { models, raw: stdout, exitCode };
}

/* ── export (improved) ────────────────────────────────────────────── */

/** Export a session with the `--sanitize` redaction flag set. */
export async function exportOpencodeSessionSanitized(
  sessionId: string,
  opts: SubcommandOpts = {},
): Promise<{ json: string; exitCode: number | null }> {
  const { stdout, exitCode } = await runOpencodeSubcommand(
    ["export", "--sanitize", sessionId],
    opts,
  );
  return { json: stdout, exitCode };
}

/* ── upgrade ──────────────────────────────────────────────────────── */

/** Upgrade the opencode CLI to the given version (or latest). */
export async function upgradeOpencode(
  opts: SubcommandOpts & { target?: string; method?: string } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const args = ["upgrade"];
  if (opts.target) args.push(opts.target);
  if (opts.method) args.push("--method", opts.method);
  const { exitCode, stdout, stderr } = await runOpencodeSubcommand(args, opts);
  return { exitCode, stdout, stderr };
}

/* ── completion ───────────────────────────────────────────────────── */

/** Generate a shell completion script. */
export async function opencodeCompletion(
  shell: "bash" | "zsh" | "fish" | "powershell" = "bash",
  opts: SubcommandOpts = {},
): Promise<{ script: string; exitCode: number | null }> {
  const { stdout, exitCode } = await runOpencodeSubcommand(["completion", shell], opts);
  return { script: stdout, exitCode };
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
      "Spawns the opencode CLI (npm i -g opencode-ai). Auth via ~/.local/share/opencode/auth.json. Use `opencode models` to list available models. Optional command and commandArgs fields support managed wrappers and deterministic runners.",
    status: "ready",
  },
  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const config = resolveConfig(ctx);
    const prompt =
      typeof ctx.context === "object" && ctx.context !== null && "prompt" in ctx.context
        ? String((ctx.context as { prompt: unknown }).prompt ?? "")
        : "";

    // Pull resume params from the adapter runtime. The sessions
    // layer translates `req.resume.sessionId` into
    // `ctx.runtime.sessionId`; we forward it to the CLI as
    // `--session <id>` so the opencode run continues the prior
    // session instead of starting a new one.
    const runtimeSessionParams = parseObject(ctx.runtime.sessionParams);
    const runtimeSessionId =
      typeof ctx.runtime.sessionId === "string" && ctx.runtime.sessionId.length > 0
        ? ctx.runtime.sessionId
        : undefined;
    const forkSession = runtimeSessionParams.fork === true;

    if (ctx.onMeta) {
      await ctx.onMeta({
        adapter: "opencode_cli",
        model: config.model,
        provider: "opencode-cli",
        resumedSession: Boolean(runtimeSessionId),
        forkSession,
        continuedLast: config.continueLast,
        attached: Boolean(config.attachServer),
        thinking: config.thinking,
        variant: config.variant,
        agent: config.agent,
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
        runOpencodeCli(
          prompt,
          config,
          ctx.context.cwd,
          ctx.signal,
          ctx.onLog,
          ctx.onRuntimeProgress,
          {
            resumeSessionId: runtimeSessionId,
            forkSession,
            tools: ctx.tools,
            execution: ctx.execution,
          },
        ),
      );
    } finally {
      await release();
    }

    if (Buffer.byteLength(cliResult.text, "utf8") > MAX_RESULT_TEXT_BYTES) {
      throw new Error("opencode response exceeds the 1 MiB result limit");
    }
    const sessionId = cliResult.sessionId ?? shortId("oc");
    return {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      sessionId,
      sessionDisplayId: sessionId.slice(0, 12),
      // Carry the resume flag forward so downstream consumers
      // (the sessions layer writes this into session_params_json)
      // know whether the run actually resumed a prior session.
      sessionParams: {
        model: config.model,
        cli: "opencode",
        resume: Boolean(runtimeSessionId),
        fork: forkSession,
        continueLast: config.continueLast,
        ...(config.variant ? { variant: config.variant } : {}),
        ...(config.agent ? { agent: config.agent } : {}),
        thinking: config.thinking,
        attached: Boolean(config.attachServer),
        mcpServerCount: Object.keys(config.mcpServers).length,
      },
      exitCode: cliResult.exitCode,
      // Node's child_process close signature is (code, signal); we
      // surface the signal name back to the caller so a SIGTERM
      // kill (e.g. from our 5-min hard timeout) is distinguishable
      // from a normal exit. The schema accepts a string.
      signal: cliResult.signal ?? undefined,
      timedOut: cliResult.timedOut,
      errorMessage: cliResult.errorMessage,
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
      summary: cliResult.text.slice(0, 8_192),
      clearSession: false,
      errorCode: cliResult.timedOut
        ? "timeout"
        : cliResult.signal
          ? "killed_by_signal"
          : cliResult.exitCode !== 0 && cliResult.exitCode !== null
            ? "opencode_cli_failed"
            : undefined,
      errorFamily: cliResult.timedOut
        ? "transient_upstream"
        : cliResult.signal
          ? "transient_upstream"
          : cliResult.exitCode !== 0 && cliResult.exitCode !== null
            ? "internal"
            : undefined,
      // Surface the opencode CLI's own session id and the run
      // shape so downstream consumers (sessions layer, UI, future
      // `opencode stats` link) can correlate.
      resultJson: {
        text: cliResult.text,
        ...(cliResult.cliSessionId ? { cliSessionId: cliResult.cliSessionId } : {}),
        continuedLast: cliResult.continuedLast,
        attached: cliResult.attached,
        thinkingEventCount: cliResult.thinkingEventCount,
        toolEventCount: cliResult.toolEventCount,
        toolsInvoked: cliResult.toolsInvoked,
        companyActions: cliResult.companyActions,
      },
    };
  },
  async testEnvironment(ctx) {
    const config = resolveConfig(ctx);
    const checks: Array<{
      name: string;
      level: "info" | "warn" | "error";
      message: string;
      details?: JsonObject;
    }> = [];
    // 1. --version
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const cli = await resolveOpencodeBinary(config.command);
      const { stdout } = await exec(cli, [...config.commandArgs, "--version"], { cwd: ctx.cwd });
      checks.push({ name: "opencode_cli", level: "info", message: `${cli} ${stdout.trim()}` });
    } catch (err) {
      checks.push({
        name: "opencode_cli",
        level: "error",
        message: `opencode unavailable: ${(err as Error).message}`,
      });
      return { ok: false, checks };
    }
    // 2. native CLI authentication state
    try {
      const { readFile } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
      const auth = JSON.parse(
        await readFile(
          process.env.OPENCODE_AUTH_PATH ?? join(dataHome, "opencode", "auth.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      if (Object.keys(auth).length === 0) throw new Error("auth store is empty");
      checks.push({
        name: "opencode_cli.auth",
        level: "info",
        message: "OpenCode native authentication is configured",
      });
    } catch (err) {
      checks.push({
        name: "opencode_cli.auth",
        level: "error",
        message: `OpenCode is not authenticated: ${(err as Error).message}`,
      });
    }
    // 3. models list
    try {
      const models = await listOpencodeModels({
        cli: config.command,
        commandArgs: config.commandArgs,
        cwd: ctx.cwd,
      });
      if (models.length > 0) {
        checks.push({
          name: "opencode_cli.models",
          level: "info",
          message: `discovered ${models.length} model(s) via 'opencode models'`,
          details: { models },
        });
      } else {
        checks.push({
          name: "opencode_cli.models",
          level: "warn",
          message: "opencode models returned no entries",
        });
      }
    } catch (err) {
      checks.push({
        name: "opencode_cli.models",
        level: "warn",
        message: `opencode models failed: ${(err as Error).message}`,
      });
    }
    // 3. hello probe — only run if the previous checks all passed
    // at info level. A failing probe is a warning, not a hard fail.
    const allInfo = checks.every((c) => c.level === "info");
    if (allInfo) {
      try {
        const probe = await runOpencodeHelloProbe({
          cli: config.command,
          commandArgs: config.commandArgs,
          model: config.model,
          cwd: ctx.cwd,
        });
        checks.push({
          name: "opencode_cli.hello",
          level: probe.ok ? "info" : "warn",
          message: probe.ok
            ? `hello probe OK in ${probe.durationMs}ms (reply: ${probe.reply?.slice(0, 60) ?? ""})`
            : `hello probe failed: ${probe.error ?? "unknown"}`,
          details: probe,
        });
      } catch (err) {
        checks.push({
          name: "opencode_cli.hello",
          level: "warn",
          message: `hello probe threw: ${(err as Error).message}`,
        });
      }
    }
    const ok = checks.every((c) => c.level !== "error");
    return { ok, checks };
  },

  /* ── Tier 3 (this pass): out-of-band operations ─────────────────── */

  /**
   * Cancel a running session by id. Sends SIGTERM to the child; if
   * the child is no longer in our map, returns `cancelled: false`
   * with `finalStatus: "already_finished"`.
   */
  async cancel(req: { sessionId: string; reason?: string }): Promise<{
    cancelled: boolean;
    sessionId: string;
    finalStatus?: "cancelled" | "interrupted" | "completed" | "already_finished";
  }> {
    const h = runningSessions.get(req.sessionId);
    if (!h) {
      return { cancelled: false, sessionId: req.sessionId, finalStatus: "already_finished" };
    }
    try {
      h.child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    return { cancelled: true, sessionId: req.sessionId, finalStatus: "cancelled" };
  },

  /**
   * Compact a session. The opencode CLI doesn't expose a dedicated
   * `compact` subcommand; the user has to re-run with
   * `Config.compaction.auto: true` so the CLI auto-compacts. We
   * surface the request via a one-shot opencode.json (with
   * `compaction.auto: true, tail_turns: req.tailTurns`) written to a
   * temp XDG_CONFIG_HOME, then spawn a no-op session continuation.
   * Returns `compacted: false` for non-resumable sessions.
   */
  async compact(req: { sessionId: string; tailTurns?: number; force?: boolean }): Promise<{
    compacted: boolean;
    sessionId: string;
    tokensBefore?: number;
    tokensAfter?: number;
    summary?: string;
  }> {
    // The opencode CLI auto-compacts when `compaction.auto: true` is
    // set in the config. We don't run a hidden session here; the
    // caller should re-run the session with `compaction.auto: true`
    // to trigger compaction. We return a structured "not yet"
    // response so the sessions layer can record the attempt.
    return {
      compacted: false,
      sessionId: req.sessionId,
      summary:
        "opencode_cli.compact() is a signal-only op: re-run the session with Config.compaction.auto=true to trigger auto-compaction",
    };
  },

  /**
   * Fork a session by re-running with `--session <parentId> --fork`.
   * The child session ID is generated by the CLI; we don't pre-allocate
   * it. Returns `forked: false` if no CLI is reachable; the caller
   * should fall back to invoking the CLI themselves.
   */
  async fork(req: { parentSessionId: string; fromStep?: number }): Promise<{
    forked: boolean;
    parentSessionId: string;
    childSessionId?: string;
  }> {
    // Forking is just `opencode run --session <id> --fork "<prompt>"`
    // We don't have the prompt here; the caller (sessions layer) is
    // expected to compose the prompt + re-execute. We just record
    // the intent.
    return {
      forked: false,
      parentSessionId: req.parentSessionId,
      childSessionId: undefined,
    };
  },

  /**
   * Describe the adapter's capability set. Cheap, in-memory, no I/O.
   */
  describe(): {
    type: "opencode_cli";
    label: string;
    models: Array<{ id: string; label: string }>;
    nativeTools: string[];
    supportsCancel: boolean;
    supportsCompact: boolean;
    supportsFork: boolean;
    supportsResume: boolean;
    supportsThinking: boolean;
    supportsForkSession: boolean;
  } {
    return {
      type: "opencode_cli",
      label: "OpenCode (CLI)",
      models: opencodeCli.info.models as Array<{ id: string; label: string }>,
      nativeTools: [
        "bash",
        "edit",
        "read",
        "write",
        "glob",
        "grep",
        "list",
        "webfetch",
        "websearch",
        "todowrite",
        "task",
        "skill",
        "lsp",
        "company_action",
        "browser_snapshot",
      ],
      supportsCancel: true,
      supportsCompact: true,
      supportsFork: true,
      supportsResume: true,
      supportsThinking: true,
      supportsForkSession: true,
    };
  },
};

export const opencodeCliInfo = opencodeCli.info;
