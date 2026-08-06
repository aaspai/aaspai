import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterBillingType,
  AdapterCancelResult,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  ErrorFamily,
  UsageSummary,
} from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import {
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeStatus,
  type AcpRuntimeTurn,
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
} from "acpx/runtime";
import { buildAgentEnv } from "./env.js";
import { redactHomePath } from "./redact.js";

export type AcpAgent = "claude" | "codex" | "gemini";

const MIN_NODE_VERSION: Record<AcpAgent, [number, number, number]> = {
  claude: [22, 12, 0],
  codex: [22, 13, 0],
  gemini: [20, 0, 0],
};
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

type AcpConfig = {
  agentCommand?: string;
  mode: "persistent" | "oneshot";
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  stateDir: string;
  cwd?: string;
  timeoutMs?: number;
  model?: string;
  effort?: string;
  fastMode: boolean;
  allowedTools?: string[];
  maxTurns?: number;
  warmHandleIdleMs: number;
};

type RuntimeFactory = typeof createAcpRuntime;

export type WarmRuntime = {
  runtime: AcpRuntime;
  lastUsedAt: number;
  handles: Map<string, AcpRuntimeHandle>;
};

const DEFAULT_WARM_HANDLE_IDLE_MS = 0;
const DEFAULT_WARM_RUNTIMES = new Map<string, WarmRuntime>();
const ACTIVE_ACP_RUNS = new Map<string, { runtime: AcpRuntime; handle: AcpRuntimeHandle }>();

export interface AcpExecutorOptions {
  createRuntime?: RuntimeFactory;
  nodeVersion?: string;
  warmRuntimes?: Map<string, WarmRuntime>;
}

function normalizeAgentCommand(command: string | undefined): string | undefined {
  if (!command || process.platform !== "win32") return command;
  return command.replaceAll("\\", "/");
}

export function nodeVersionMeetsAcpMinimum(agent: AcpAgent, version = process.version): boolean {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [actualMajor, actualMinor, actualPatch] = match.slice(1, 4).map(Number) as [
    number,
    number,
    number,
  ];
  const [requiredMajor, requiredMinor, requiredPatch] = MIN_NODE_VERSION[agent];
  if (actualMajor !== requiredMajor) return actualMajor > requiredMajor;
  if (actualMinor !== requiredMinor) return actualMinor > requiredMinor;
  if (actualPatch !== requiredPatch) return actualPatch > requiredPatch;
  return true;
}

export function parseAcpConfig(
  agent: AcpAgent,
  config: JsonObject,
  defaults: {
    stateDir?: string;
    timeoutSec?: number;
    organizationId?: string;
    agentId?: string;
  } = {},
): AcpConfig {
  const getString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = config[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const getNumber = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = config[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return undefined;
  };
  const getBoolean = (...keys: string[]): boolean =>
    keys.some((key) => config[key] === true || config[key] === "true");
  const getStringArray = (...keys: string[]): string[] | undefined => {
    for (const key of keys) {
      const value = config[key];
      if (!Array.isArray(value)) continue;
      const result = value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      );
      if (result.length > 0) return result.map((entry) => entry.trim());
    }
    return undefined;
  };
  const mode = getString("mode", "acpMode") === "oneshot" ? "oneshot" : "persistent";
  const permissionRaw = getString("acpPermissionMode", "permissionMode", "approvalMode");
  const permissionMode =
    permissionRaw === "approve-reads" || permissionRaw === "deny-all"
      ? permissionRaw
      : permissionRaw === "plan"
        ? "deny-all"
        : permissionRaw === "accept-edits"
          ? "approve-reads"
          : permissionRaw === "untrusted"
            ? "deny-all"
            : permissionRaw === "on-request" || permissionRaw === "on-failure"
              ? "approve-reads"
              : "approve-all";
  const nonInteractivePermissions =
    getString("nonInteractivePermissions", "acpNonInteractivePermissions") === "fail"
      ? "fail"
      : "deny";
  const stateDir = resolve(
    getString("stateDir", "acpStateDir") ??
      defaults.stateDir ??
      join(
        homedir(),
        ".aaspai",
        "acp",
        defaults.organizationId ?? "default-organization",
        defaults.agentId ?? "default-agent",
        agent,
      ),
  );
  const timeoutSec = getNumber("timeoutSec") ?? defaults.timeoutSec;
  const maxTurns = getNumber("maxTurns");
  const warmHandleIdleMs = getNumber("warmHandleIdleMs", "acpWarmHandleIdleMs");
  return {
    agentCommand: normalizeAgentCommand(getString("agentCommand", "acpAgentCommand")),
    mode,
    permissionMode,
    nonInteractivePermissions,
    stateDir,
    cwd: getString("cwd"),
    timeoutMs: timeoutSec && timeoutSec > 0 ? Math.round(timeoutSec * 1_000) : undefined,
    model: getString("model"),
    effort: getString("effort", "modelReasoningEffort", "reasoningEffort"),
    fastMode: getBoolean("fastMode"),
    allowedTools: getStringArray("acpAllowedTools", "allowedTools", "tools"),
    maxTurns: maxTurns && maxTurns > 0 ? Math.floor(maxTurns) : undefined,
    warmHandleIdleMs:
      warmHandleIdleMs === undefined
        ? DEFAULT_WARM_HANDLE_IDLE_MS
        : Math.max(0, Math.floor(warmHandleIdleMs)),
  };
}

function sessionKey(ctx: AdapterExecutionContext, agent: AcpAgent, config: AcpConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        agent,
        id: ctx.agent.id,
        organizationId: ctx.organizationId,
        cwd: resolve(ctx.context.cwd),
        mode: config.mode,
        command: config.agentCommand,
        permissionMode: config.permissionMode,
        nonInteractivePermissions: config.nonInteractivePermissions,
        stateDir: config.stateDir,
        model: config.model,
        effort: config.effort,
        fastMode: config.fastMode,
        allowedTools: config.allowedTools,
        maxTurns: config.maxTurns,
        systemPrompt: ctx.context.systemPrompt,
        env: ctx.config.env,
        runtimeEnv: Object.fromEntries(
          Object.entries(runtimeEnv(ctx)).filter(
            ([name]) =>
              !["AASPAI_RUN_ID", "AASPAI_SESSION_ID", "AASPAI_SESSION_DISPLAY_ID"].includes(name),
          ),
        ),
        executionIdentity: ctx.execution?.identity,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

function localAgentCommand(agent: AcpAgent, config: JsonObject = {}): string | undefined {
  if (agent === "gemini") {
    const configuredCommand =
      typeof config.command === "string" && config.command.trim()
        ? config.command.trim()
        : "gemini";
    return `${configuredCommand} --acp`;
  }
  const packageName = agent === "claude" ? "claude-agent-acp" : "codex-acp";
  let current = resolve(MODULE_DIR);
  while (true) {
    const candidate = join(
      current,
      "node_modules",
      "@agentclientprotocol",
      packageName,
      "dist",
      "index.js",
    );
    if (existsSync(candidate)) {
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      return `${quote(process.execPath)} ${quote(candidate)}`;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function agentCommandOverride(agent: string, command: string | undefined): Record<string, string> {
  return command === undefined ? {} : { [agent]: command };
}

function runtimeEnv(ctx: AdapterExecutionContext): Record<string, string> {
  const managed = ctx.execution?.environment;
  const hostEnv =
    managed?.inheritEnv === false
      ? Object.fromEntries(Object.keys(process.env).map((key) => [key, ""]))
      : Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
  const configured = ctx.config.env;
  const identityEnv = buildAgentEnv(ctx.agent, {
    runId: ctx.runId,
    sessionId: ctx.runtime.sessionId,
    sessionDisplayId: ctx.runtime.sessionDisplayId,
    cwd: ctx.context.cwd,
  });
  const configuredEnv = buildAgentEnv(ctx.agent, {
    runId: ctx.runId,
    sessionId: ctx.runtime.sessionId,
    sessionDisplayId: ctx.runtime.sessionDisplayId,
    cwd: ctx.context.cwd,
    additionalEnv:
      configured && typeof configured === "object" && !Array.isArray(configured)
        ? (configured as Record<string, string>)
        : undefined,
  });
  return {
    ...hostEnv,
    ...configuredEnv,
    ...(managed?.env ?? {}),
    ...identityEnv,
  };
}

function previousAcpSessionId(ctx: AdapterExecutionContext): string | undefined {
  const params = ctx.runtime.sessionParams;
  if (params) {
    if (typeof params.cliSessionId === "string" && params.acp !== true) return undefined;
    for (const key of [
      "acpSessionId",
      "backendSessionId",
      "agentSessionId",
      "runtimeSessionName",
      "sessionId",
    ]) {
      if (typeof params[key] === "string" && params[key].trim()) return params[key];
    }
  }
  if (params && Object.keys(params).length > 0) return undefined;
  return ctx.runtime.sessionId;
}

function statusUsage(status: AcpRuntimeStatus | undefined): UsageSummary | undefined {
  const usage = status?.usage?.cumulative;
  if (!usage) return undefined;
  const result: UsageSummary = {};
  if (typeof usage.inputTokens === "number") result.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") result.outputTokens = usage.outputTokens;
  if (typeof usage.cachedReadTokens === "number") result.cachedInputTokens = usage.cachedReadTokens;
  return result;
}

function diffUsage(
  before: AcpRuntimeStatus | undefined,
  after: AcpRuntimeStatus | undefined,
): UsageSummary | undefined {
  const oldUsage = statusUsage(before);
  const newUsage = statusUsage(after);
  if (!newUsage) return undefined;
  const result: UsageSummary = {};
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"] as const) {
    const value = newUsage[key];
    if (value === undefined) continue;
    const previous = oldUsage?.[key] ?? 0;
    result[key] = Math.max(0, value - previous);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function eventJson(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

async function emitEvent(
  ctx: AdapterExecutionContext,
  event: AcpRuntimeEvent,
  textParts: string[],
): Promise<void> {
  if (event.type === "text_delta") {
    const kind = event.stream === "thought" ? "thinking" : "assistant";
    if (event.stream !== "thought") textParts.push(event.text);
    await ctx.onLog(
      "stdout",
      eventJson({
        kind,
        ts: new Date().toISOString(),
        text: redactHomePath(event.text),
        delta: true,
      }),
    );
  } else if (event.type === "tool_call") {
    const status =
      event.status === "completed" || event.status === "failed" ? event.status : "started";
    await ctx.onLog(
      "stdout",
      eventJson({
        kind: status === "started" ? "tool_call" : "tool_result",
        ts: new Date().toISOString(),
        name: event.title ?? "tool",
        id: event.toolCallId,
        status,
        input: isObject(event.rawInput) ? event.rawInput : undefined,
        output: typeof event.rawOutput === "string" ? redactHomePath(event.rawOutput) : undefined,
        isError: status === "failed",
      }),
    );
  } else if (event.type === "status" && event.text.trim()) {
    await ctx.onLog(
      "stdout",
      eventJson({ kind: "system", ts: new Date().toISOString(), text: redactHomePath(event.text) }),
    );
  }
  await ctx.onRuntimeProgress?.(event);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function classifyAcpError(error: unknown): ErrorFamily {
  const message = redactHomePath(error instanceof Error ? error.message : String(error));
  const lower = message.toLowerCase();
  if (lower.includes("auth") || lower.includes("api key") || lower.includes("credential"))
    return "auth";
  if (lower.includes("quota") || lower.includes("rate limit") || lower.includes("usage limit"))
    return "provider_quota";
  if (lower.includes("refus") || lower.includes("permission")) return "model_refusal";
  return "transient_upstream";
}

function resultForError(
  error: unknown,
  messagePrefix = "ACP execution failed",
): AdapterExecutionResult {
  const message = redactHomePath(error instanceof Error ? error.message : String(error));
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: 1,
    timedOut: false,
    errorMessage: `${messagePrefix}: ${message}`.slice(0, 8_192),
    errorCode: "acp_execution_failed",
    errorFamily: classifyAcpError(error),
    summary: messagePrefix,
    usageBasis: "per_run",
    clearSession: false,
  };
}

function localRuntimeIdentity(ctx: AdapterExecutionContext): JsonObject | undefined {
  const identity = ctx.execution?.identity;
  if (identity?.kind !== "local" || typeof identity.cwd !== "string") return undefined;
  return { kind: "local", cwd: identity.cwd };
}

export async function cancelAcpSession(sessionId: string): Promise<AdapterCancelResult> {
  const active = ACTIVE_ACP_RUNS.get(sessionId);
  if (!active) return { cancelled: false, sessionId, finalStatus: "already_finished" };
  try {
    await active.runtime.cancel({ handle: active.handle, reason: "out-of-band cancellation" });
    return { cancelled: true, sessionId, finalStatus: "cancelled" };
  } catch {
    return { cancelled: false, sessionId, finalStatus: "interrupted" };
  }
}

function billingIdentity(
  ctx: AdapterExecutionContext,
  agent: AcpAgent,
): { provider: string; biller: string; billingType: AdapterBillingType } {
  const env = runtimeEnv(ctx);
  if (agent === "claude") {
    const bedrock =
      env.CLAUDE_CODE_USE_BEDROCK === "1" ||
      env.CLAUDE_CODE_USE_BEDROCK === "true" ||
      Boolean(env.ANTHROPIC_BEDROCK_BASE_URL);
    if (bedrock)
      return { provider: "anthropic", biller: "aws-bedrock", billingType: "metered_api" };
    if (env.ANTHROPIC_API_KEY?.trim()) {
      return { provider: "anthropic", biller: "anthropic", billingType: "api" };
    }
    return { provider: "anthropic", biller: "claude-code", billingType: "subscription" };
  }
  if (agent === "gemini") {
    const hasApiKey = Boolean(env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim());
    return {
      provider: "google",
      biller: hasApiKey ? "google" : "gemini-cli",
      billingType: hasApiKey ? "api" : "subscription",
    };
  }
  return {
    provider: "openai",
    biller: env.OPENAI_API_KEY?.trim() ? "openai" : "chatgpt",
    billingType: env.OPENAI_API_KEY?.trim() ? "api" : "subscription",
  };
}

export type AcpEngineSelection = {
  engine: "acp" | "cli";
  explicit: boolean;
  fallbackReason?: string;
};

type AcpEngineContext = {
  config: JsonObject;
  cwd?: string;
  execution?: AdapterExecutionContext["execution"];
  organizationId?: string;
  agentId?: string;
};

function requestedEngine(config: JsonObject): { engine: "acp" | "cli"; explicit: boolean } {
  const value = typeof config.engine === "string" ? config.engine.trim().toLowerCase() : "auto";
  if (value === "cli") return { engine: "cli", explicit: true };
  if (value === "acp") return { engine: "acp", explicit: true };
  return { engine: "acp", explicit: false };
}

function unsupportedAcpConfiguration(agent: AcpAgent, config: JsonObject): string | undefined {
  const extraArgs = Array.isArray(config.extraArgs)
    ? config.extraArgs.filter((value): value is string => typeof value === "string")
    : [];
  if (extraArgs.length > 0) {
    return `${agent} ACP does not support CLI extraArgs; remove them or select engine=cli`;
  }
  if (agent === "claude" && config.chrome === true) {
    return "Claude ACP does not support the CLI chrome flag; select engine=cli";
  }
  if (agent === "codex" && config.sandbox === "danger-full-access") {
    return "Codex ACP cannot guarantee danger-full-access sandbox semantics; select engine=cli";
  }
  const permission = [config.acpPermissionMode, config.permissionMode, config.approvalMode].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (
    permission &&
    ![
      "approve-all",
      "approve-reads",
      "deny-all",
      "default",
      "bypass-permissions",
      "accept-edits",
      "plan",
      "untrusted",
      "on-request",
      "on-failure",
      "never",
    ].includes(permission)
  ) {
    return `${agent} ACP does not support permission mode ${permission}; select a supported mode or engine=cli`;
  }
  if (agent !== "codex" && config.fastMode === true) {
    return `${agent} ACP does not support fastMode; select engine=cli`;
  }
  return undefined;
}

async function acpPrerequisiteFailure(
  agent: AcpAgent,
  input: AcpEngineContext,
  options: Pick<AcpExecutorOptions, "createRuntime" | "nodeVersion"> = {},
): Promise<string | undefined> {
  if (!nodeVersionMeetsAcpMinimum(agent, options.nodeVersion)) {
    return `${agent} ACP requires Node >=${MIN_NODE_VERSION[agent].join(".")} (running ${process.version})`;
  }
  const parsed = parseAcpConfig(agent, input.config, {
    organizationId: input.organizationId,
    agentId: input.agentId,
  });
  const unsupported = unsupportedAcpConfiguration(agent, input.config);
  if (unsupported) return unsupported;
  const agentCommand = parsed.agentCommand ?? localAgentCommand(agent, input.config);
  try {
    const cwd = resolve(
      input.cwd ?? (typeof input.config.cwd === "string" ? input.config.cwd : process.cwd()),
    );
    await mkdir(parsed.stateDir, { recursive: true });
    const runtime = (options.createRuntime ?? createAcpRuntime)({
      cwd,
      sessionStore: createRuntimeStore({ stateDir: parsed.stateDir }),
      agentRegistry: createAgentRegistry({ overrides: agentCommandOverride(agent, agentCommand) }),
      probeAgent: agent,
      permissionMode: parsed.permissionMode,
      nonInteractivePermissions: parsed.nonInteractivePermissions,
    });
    const doctor = await runtime.doctor?.();
    if (doctor?.ok === false) return doctor.message;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export async function resolveAcpEngine(
  agent: AcpAgent,
  input: AcpEngineContext,
  options: Pick<AcpExecutorOptions, "createRuntime" | "nodeVersion"> = {},
): Promise<AcpEngineSelection> {
  const requested = requestedEngine(input.config);
  if (requested.explicit && requested.engine === "cli") return requested;
  if (input.execution) {
    if (input.execution.identity?.kind !== "local") {
      return requested.explicit
        ? requested
        : {
            engine: "cli",
            explicit: false,
            fallbackReason: "ACP requires a local or bidirectional managed runtime boundary",
          };
    }
    if (!input.execution.environment) {
      return requested.explicit
        ? requested
        : {
            engine: "cli",
            explicit: false,
            fallbackReason: "ACP requires the managed runtime to provide a controlled environment",
          };
    }
  }
  const failure = await acpPrerequisiteFailure(agent, input, options);
  if (!failure) return requested;
  return requested.explicit
    ? requested
    : { engine: "cli", explicit: false, fallbackReason: failure };
}

export async function executeAcp(
  ctx: AdapterExecutionContext,
  agent: AcpAgent,
  defaults: { timeoutSec?: number; stateDir?: string } = {},
  options: AcpExecutorOptions = {},
): Promise<AdapterExecutionResult> {
  if (!nodeVersionMeetsAcpMinimum(agent, options.nodeVersion)) {
    return resultForError(
      new Error(
        `${agent} ACP requires Node >=${MIN_NODE_VERSION[agent].join(".")} (running ${process.version})`,
      ),
      "ACP prerequisite failed",
    );
  }
  if (ctx.execution && (ctx.execution.identity?.kind !== "local" || !ctx.execution.environment)) {
    return {
      ...resultForError(
        new Error(
          "ACP requires a bidirectional runtime channel; the selected managed target is not local",
        ),
        "ACP runtime boundary unavailable",
      ),
      errorCode: "acp_runtime_boundary_unavailable",
      errorFamily: "config",
    };
  }

  const config = parseAcpConfig(agent, ctx.config, {
    ...defaults,
    organizationId: ctx.organizationId,
    agentId: ctx.agent.id,
  });
  const unsupported = unsupportedAcpConfiguration(agent, ctx.config);
  if (unsupported) return resultForError(new Error(unsupported), "ACP configuration unsupported");
  const billing = billingIdentity(ctx, agent);
  const cwd = resolve(config.cwd ?? ctx.context.cwd);
  const acpAgent = agent;
  const key = sessionKey(ctx, agent, config);
  const warmRuntimes = options.warmRuntimes ?? DEFAULT_WARM_RUNTIMES;
  const useWarmRuntime = config.mode === "persistent" && config.warmHandleIdleMs > 0;
  if (useWarmRuntime) {
    const now = Date.now();
    for (const [cachedKey, cached] of warmRuntimes) {
      if (now - cached.lastUsedAt <= config.warmHandleIdleMs) continue;
      for (const cachedHandle of cached.handles.values()) {
        await cached.runtime.close({ handle: cachedHandle, reason: "idle" }).catch(() => {});
      }
      warmRuntimes.delete(cachedKey);
    }
  }
  const cached = useWarmRuntime ? warmRuntimes.get(key) : undefined;
  let runtime: AcpRuntime | undefined = cached?.runtime;
  try {
    if (!runtime) {
      await mkdir(config.stateDir, { recursive: true });
      const agentCommand = config.agentCommand ?? localAgentCommand(acpAgent, ctx.config);
      const registry = createAgentRegistry({
        overrides: agentCommandOverride(acpAgent, agentCommand),
      });
      runtime = (options.createRuntime ?? createAcpRuntime)({
        cwd,
        sessionStore: createRuntimeStore({ stateDir: config.stateDir }),
        agentRegistry: registry,
        probeAgent: acpAgent,
        permissionMode: config.permissionMode,
        nonInteractivePermissions: config.nonInteractivePermissions,
        timeoutMs: config.timeoutMs,
        verbose: agent === "claude" || agent === "gemini",
      });
      if (useWarmRuntime) {
        warmRuntimes.set(key, { runtime, lastUsedAt: Date.now(), handles: new Map() });
      }
    }
  } catch (error) {
    return resultForError(error, "ACP initialization failed");
  }
  if (!runtime)
    return resultForError(
      new Error("ACP runtime was not initialized"),
      "ACP initialization failed",
    );
  const sessionOptions = {
    ...(config.model ? { model: config.model } : {}),
    ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
    ...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
    ...(ctx.context.systemPrompt ? { systemPrompt: ctx.context.systemPrompt } : {}),
    env: runtimeEnv(ctx),
  };

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapter: `${agent}_local`,
      engine: "acp",
      agent: acpAgent,
      mode: config.mode,
      permissionMode: config.permissionMode,
      resumedSession: Boolean(previousAcpSessionId(ctx)),
      stateDir: redactHomePath(config.stateDir),
    });
  }

  let handle: AcpRuntimeHandle | undefined;
  let turn: AcpRuntimeTurn | undefined;
  let timedOut = false;
  let clearSession = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
    void turn?.cancel({ reason: "execution cancelled" }).catch(() => {});
  };
  if (ctx.signal?.aborted) abort();
  else ctx.signal?.addEventListener("abort", abort, { once: true });

  try {
    const resumeSessionId = previousAcpSessionId(ctx);
    try {
      handle = await runtime.ensureSession({
        sessionKey: key,
        agent: acpAgent,
        mode: config.mode,
        cwd,
        resumeSessionId,
        sessionOptions,
      });
    } catch (error) {
      if (!resumeSessionId) throw error;
      clearSession = true;
      await ctx.onLog(
        "stdout",
        eventJson({
          kind: "system",
          ts: new Date().toISOString(),
          text: `ACP session ${resumeSessionId} was unavailable; starting a fresh session.`,
        }),
      );
      handle = await runtime.ensureSession({
        sessionKey: key,
        agent: acpAgent,
        mode: config.mode,
        cwd,
        sessionOptions,
      });
    }
    if (config.effort || config.fastMode) {
      if (!runtime.setConfigOption) {
        throw new Error(
          "The installed ACP runtime cannot apply effort or fast-mode settings; remove those settings or select engine=cli",
        );
      }
      if (config.effort) {
        await runtime.setConfigOption({
          handle,
          key: agent === "codex" ? "reasoning_effort" : "effort",
          value: config.effort,
        });
      }
      if (config.fastMode) {
        await runtime.setConfigOption({ handle, key: "service_tier", value: "fast" });
        await runtime.setConfigOption({ handle, key: "features.fast_mode", value: "true" });
      }
    }
    if (useWarmRuntime) {
      const entry = warmRuntimes.get(key) as unknown as {
        lastUsedAt: number;
        handles: Map<string, unknown>;
      };
      entry.lastUsedAt = Date.now();
      entry.handles.set(key, handle);
    }
    const activeIds = [
      key,
      handle.backendSessionId,
      handle.agentSessionId,
      handle.runtimeSessionName,
    ].filter((value): value is string => Boolean(value));
    for (const activeId of activeIds) ACTIVE_ACP_RUNS.set(activeId, { runtime, handle });
    const before = runtime.getStatus
      ? await runtime.getStatus({ handle }).catch(() => undefined)
      : undefined;
    if (config.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        abort();
      }, config.timeoutMs);
      timeoutHandle.unref();
    }
    turn = runtime.startTurn({
      handle,
      text: ctx.context.prompt,
      mode: "prompt",
      requestId: ctx.runId,
      timeoutMs: config.timeoutMs,
      signal: controller.signal,
    });
    const textParts: string[] = [];
    for await (const event of turn.events) await emitEvent(ctx, event, textParts);
    const terminal = await turn.result;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    const after = runtime.getStatus
      ? await runtime.getStatus({ handle }).catch(() => undefined)
      : undefined;
    const usage = diffUsage(before, after);
    const sessionId = handle.backendSessionId ?? handle.agentSessionId ?? handle.runtimeSessionName;
    const stopReason =
      terminal.status === "failed" ? redactHomePath(terminal.error.message) : terminal.stopReason;
    const errorMessage =
      timedOut || terminal.status === "cancelled"
        ? timedOut
          ? "ACP run exceeded timeout"
          : "ACP run cancelled"
        : terminal.status === "failed"
          ? stopReason
          : undefined;
    if (!useWarmRuntime || timedOut || errorMessage) {
      await runtime.close({ handle, reason: timedOut ? "timeout" : "completed" }).catch(() => {});
      warmRuntimes.get(key)?.handles.delete(key);
      warmRuntimes.delete(key);
    }
    for (const activeId of [
      key,
      handle.backendSessionId,
      handle.agentSessionId,
      handle.runtimeSessionName,
    ]) {
      if (activeId) ACTIVE_ACP_RUNS.delete(activeId);
    }
    await ctx.onLog(
      "stdout",
      eventJson({
        kind: "result",
        ts: new Date().toISOString(),
        summary: textParts.join("").trim() || undefined,
        ...(stopReason ? { stopReason } : {}),
        ...(errorMessage ? { isError: true } : {}),
      }),
    );
    return {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      exitCode: errorMessage ? 1 : 0,
      signal: timedOut || terminal.status === "cancelled" ? "SIGTERM" : undefined,
      timedOut,
      errorMessage,
      errorCode: timedOut ? "acp_timeout" : errorMessage ? "acp_turn_failed" : undefined,
      errorFamily: errorMessage
        ? timedOut || terminal.status === "cancelled"
          ? "transient_upstream"
          : classifyAcpError(new Error(errorMessage))
        : undefined,
      summary: textParts.join("").trim() || stopReason || terminal.status,
      usage,
      usageBasis: "per_run",
      sessionId,
      sessionDisplayId: handle.agentSessionId ?? sessionId,
      sessionParams: {
        acp: true,
        ...(handle.backendSessionId ? { acpSessionId: handle.backendSessionId } : {}),
        ...(handle.acpxRecordId ? { acpRecordId: handle.acpxRecordId } : {}),
        ...(handle.agentSessionId ? { agentSessionId: handle.agentSessionId } : {}),
        ...(handle.runtimeSessionName ? { runtimeSessionName: handle.runtimeSessionName } : {}),
        adapter: agent,
        mode: config.mode,
      },
      ...billing,
      model: config.model,
      clearSession,
      ...(localRuntimeIdentity(ctx) ? { runtimeIdentity: localRuntimeIdentity(ctx) } : {}),
      resultJson: {
        acp: true,
        status: terminal.status,
        ...(stopReason ? { stopReason } : {}),
        ...(handle.backendSessionId ? { acpSessionId: handle.backendSessionId } : {}),
        ...(handle.acpxRecordId ? { acpRecordId: handle.acpxRecordId } : {}),
      },
    };
  } catch (error) {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (handle) await runtime.close({ handle, reason: "error" }).catch(() => {});
    if (handle) {
      for (const activeId of [
        key,
        handle.backendSessionId,
        handle.agentSessionId,
        handle.runtimeSessionName,
      ]) {
        if (activeId) ACTIVE_ACP_RUNS.delete(activeId);
      }
    }
    warmRuntimes.get(key)?.handles.delete(key);
    warmRuntimes.delete(key);
    return timedOut
      ? {
          ...resultForError(new Error("ACP run exceeded timeout")),
          timedOut: true,
          clearSession,
          errorCode: "acp_timeout",
          errorMessage: "ACP run exceeded timeout",
        }
      : { ...resultForError(error), clearSession };
  } finally {
    ctx.signal?.removeEventListener("abort", abort);
  }
}

export async function testAcpEnvironment(
  agent: AcpAgent,
  ctx: { config: unknown; cwd?: string },
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentTestResult["checks"] = [];
  const config = isObject(ctx.config) ? ctx.config : {};
  const cwd = resolve(ctx.cwd ?? (typeof config.cwd === "string" ? config.cwd : process.cwd()));
  checks.push({
    name: "acp_node",
    level: nodeVersionMeetsAcpMinimum(agent) ? "info" : "error",
    message: nodeVersionMeetsAcpMinimum(agent)
      ? `Node ${process.version} satisfies ${agent} ACP requirements`
      : `${agent} ACP requires Node >=${MIN_NODE_VERSION[agent].join(".")}`,
  });
  try {
    await mkdir(cwd, { recursive: true });
    const parsedConfig = parseAcpConfig(agent, config);
    const agentCommand = parsedConfig.agentCommand ?? localAgentCommand(agent, config);
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: createRuntimeStore({ stateDir: parsedConfig.stateDir }),
      agentRegistry: createAgentRegistry({
        overrides: agentCommandOverride(agent, agentCommand),
      }),
      probeAgent: agent,
      permissionMode: parsedConfig.permissionMode,
      nonInteractivePermissions: parsedConfig.nonInteractivePermissions,
    });
    const doctor = await runtime.doctor?.();
    checks.push({
      name: "acp_runtime",
      level: doctor?.ok === false ? "error" : "info",
      message: doctor?.message ?? `${agent} ACP runtime is available`,
      details: doctor?.details ? { details: doctor.details } : undefined,
    });
  } catch (error) {
    checks.push({
      name: "acp_runtime",
      level: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return { ok: checks.every((check) => check.level !== "error"), checks };
}
