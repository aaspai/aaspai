import path from "node:path";
import type { ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterType,
  TranscriptEntry,
} from "@aaspai/contracts/harness";
import { adapterTypeSchema, HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { type ResolvedAgentProfile, resolvedAgentProfileSchema } from "@aaspai/contracts/profile";
import type { ExecutionTarget, RunProcessResult } from "@aaspai/contracts/runtime";
import { getAdapter } from "@aaspai/harness";
import { resolveTarget } from "@aaspai/runtime";
import { assertHarnessExecutable, assertRuntimeReady } from "./capabilities.js";
import type { ExecutionStore } from "./store.js";

const DEFAULT_STUCK_AFTER_MS = 15 * 60_000;

export interface HarnessAgentInput {
  id: string;
  name: string;
  adapterType: AdapterType;
  adapterConfig: JsonObject;
  role?: string;
  tools?: AdapterExecutionContext["tools"];
  resumeSessionId?: string;
  forkSession?: boolean;
}

export interface ExecuteHarnessPlanInput {
  plan: ExecutionPlan;
  workspace: ExecutionWorkspace;
  agent?: HarnessAgentInput;
  profile?: ResolvedAgentProfile;
  durableSessionId?: string;
  /** Provider-native session ID to continue after a stalled CLI attempt. */
  resumeSessionId?: string;
  signal?: AbortSignal;
  /** Runtime-only credentials. Never persisted in the plan or session config. */
  ephemeralEnv?: Record<string, string>;
  /** Persist restored workspace output before the attempt becomes terminal. */
  onExecuted?: (result: AdapterExecutionResult) => Promise<void>;
}

/** Executes a persisted plan through a registered provider adapter. */
export class HarnessExecutionPlanRunner {
  constructor(private readonly store: ExecutionStore) {}

  async run(input: ExecuteHarnessPlanInput): Promise<AdapterExecutionResult> {
    this.assertWorkspace(input);
    const profile =
      input.profile ??
      (input.plan.profileHash !== "profile-unknown" &&
      input.plan.profileSnapshot &&
      Object.keys(input.plan.profileSnapshot).length > 0
        ? resolvedAgentProfileSchema.parse(input.plan.profileSnapshot)
        : undefined);
    if (profile && profile.profileHash !== input.plan.profileHash) {
      throw new Error("Persisted execution profile hash does not match the execution plan");
    }
    const agent: HarnessAgentInput = profile
      ? {
          id: profile.agent.id,
          name: profile.agent.title,
          adapterType: profile.harness.adapter as AdapterType,
          adapterConfig: profile.inputs.adapterConfig,
          role: profile.agent.role,
        }
      : (input.agent ??
        (() => {
          throw new Error("Execution requires a resolved profile");
        })());
    const adapterType = adapterTypeSchema.parse(input.plan.harness);
    assertHarnessExecutable(adapterType);
    await assertRuntimeReady(input.plan.target);
    const target = resolveTarget(input.plan.target);
    const targetInput = {
      ...input.plan.target,
      cwd: input.workspace.path,
    } as ExecutionPlan["target"];
    const adapter = getAdapter(adapterType);
    const policy = profile
      ? enforceRuntimeToolPolicy(
          adapterType,
          { ...agent.adapterConfig, ...input.plan.harnessConfig },
          profile,
          agent.tools,
        )
      : {
          adapterConfig: { ...agent.adapterConfig, ...input.plan.harnessConfig },
          tools: agent.tools,
        };
    const adapterConfig = policy.adapterConfig;
    const stuckAfterMs = resolveStuckAfterMs(adapterConfig);
    const session = await this.store.createHarnessSession({
      id: input.durableSessionId,
      organizationId: input.plan.organizationId,
      agentId: agent.id,
      adapter: adapterType,
      prompt: input.plan.prompt,
      runtime: { cwd: input.workspace.path },
      config: adapterConfig,
    });
    await this.store.linkHarnessSession(input.plan.attemptId, session.id);
    const currentAttempt = await this.store.getAttempt(input.plan.attemptId);
    if (currentAttempt?.status === "queued") {
      await this.store.transitionAttempt(input.plan.attemptId, "preparing");
    }

    let sessionEventSeq = 0;
    let rawOutputSeq = 0;
    let persistenceFailure: Error | undefined;
    let actualRuntimeIdentity: AdapterExecutionResult["runtimeIdentity"];
    let observedProviderSessionId: string | undefined;
    let lastProgressAt = Date.now();
    let stalled = false;
    const runController = new AbortController();
    const abortForCancellation = () => runController.abort();
    if (input.signal?.aborted) abortForCancellation();
    else input.signal?.addEventListener("abort", abortForCancellation, { once: true });
    const watchdog = setInterval(
      () => {
        if (Date.now() - lastProgressAt < stuckAfterMs) return;
        stalled = true;
        runController.abort();
      },
      Math.min(stuckAfterMs, 60_000),
    );
    watchdog.unref();
    const recordSessionEvent = async (
      kind: TranscriptEntry["kind"],
      payload: Record<string, unknown>,
      ts?: string,
    ): Promise<void> => {
      sessionEventSeq += 1;
      await this.store.appendHarnessSessionEvent({
        sessionId: session.id,
        kind,
        payload,
        ts,
        seq: sessionEventSeq,
      });
    };

    const preparedAttempt = await this.store.getAttempt(input.plan.attemptId);
    if (preparedAttempt?.status === "preparing") {
      await this.store.transitionAttempt(input.plan.attemptId, "running");
    }
    await this.store.appendNextEvent({
      organizationId: input.plan.organizationId,
      attemptId: input.plan.attemptId,
      type: "harness.session.started",
      payload: {
        harnessSessionId: session.id,
        adapter: adapterType,
        cwd: input.workspace.path,
        requestedRuntime: input.plan.target,
      },
    });

    let result: AdapterExecutionResult;
    try {
      result = await adapter.execute({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        runId: input.plan.attemptId,
        organizationId: input.plan.organizationId,
        agent: {
          id: agent.id,
          organizationId: input.plan.organizationId,
          name: agent.name,
          adapterType,
          adapterConfig,
        },
        runtime: {
          sessionId: input.resumeSessionId ?? agent.resumeSessionId,
          sessionParams: {
            resume: Boolean(input.resumeSessionId ?? agent.resumeSessionId),
            fork: agent.forkSession === true,
          },
          runtimeIdentity: {
            kind: input.plan.target.kind,
            cwd:
              input.plan.target.kind === "ssh" ? input.plan.target.remoteCwd : input.workspace.path,
          },
        },
        config: adapterConfig,
        context: {
          cwd: input.workspace.path,
          prompt: input.plan.prompt,
          systemPrompt: profile?.agent.systemPrompt ?? "",
          role: agent.role,
        },
        execution: {
          identity: {
            kind: input.plan.target.kind,
            cwd:
              input.plan.target.kind === "ssh" ? input.plan.target.remoteCwd : input.workspace.path,
          },
          run: async (options) => {
            const result = await target.run(targetInput, {
              ...options,
              cwd: input.workspace.path,
              env: {
                ...managedEnvironmentBaseline(input.plan.target.kind),
                ...managedAdapterEnvironment(options.env, adapterConfig),
                ...input.ephemeralEnv,
              },
              inheritEnv: false,
              timeoutMs: requiresRuntimeExecution(adapterType)
                ? undefined
                : (input.plan.timeoutMs ?? options.timeoutMs),
              onLog: async (stream, chunk) => {
                lastProgressAt = Date.now();
                try {
                  await this.store.appendRawOutput({
                    organizationId: input.plan.organizationId,
                    attemptId: input.plan.attemptId,
                    ts: new Date().toISOString(),
                    stream,
                    chunk,
                    seq: ++rawOutputSeq,
                  });
                } catch (error) {
                  persistenceFailure = error instanceof Error ? error : new Error(String(error));
                }
                await options.onLog?.(stream, chunk);
              },
            });
            assertRuntimeIdentity(input.plan.target, input.workspace.path, result.runtimeIdentity);
            actualRuntimeIdentity = result.runtimeIdentity;
            return result;
          },
        },
        signal: runController.signal,
        onLog: async (stream, chunk) => {
          lastProgressAt = Date.now();
          for (const line of chunk.split(/\r?\n/)) {
            if (!line) continue;
            if (stream === "stdout") {
              try {
                const parsed = JSON.parse(line) as {
                  kind?: string;
                  sessionID?: unknown;
                } & Record<string, unknown>;
                if (
                  typeof parsed.sessionID === "string" &&
                  parsed.sessionID !== observedProviderSessionId
                ) {
                  observedProviderSessionId = parsed.sessionID;
                  await this.store.setHarnessSessionProviderIdentity(session.id, parsed.sessionID);
                }
                const canonicalKinds = new Set([
                  "assistant",
                  "thinking",
                  "tool_call",
                  "tool_result",
                  "init",
                  "result",
                  "stderr",
                  "system",
                  "stdout",
                ]);
                if (parsed.kind && canonicalKinds.has(parsed.kind)) {
                  await recordSessionEvent(parsed.kind as TranscriptEntry["kind"], parsed);
                  continue;
                }
              } catch {
                // Preserve non-JSON provider output below.
              }
            }
            await recordSessionEvent(stream === "stderr" ? "stderr" : "stdout", { text: line });
          }
        },
        onMeta: async (meta) => recordSessionEvent("system", { meta }),
        tools: policy.tools,
      });
    } catch (error) {
      result = {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        exitCode: 1,
        timedOut: false,
        errorCode: "adapter_execution_failed",
        errorFamily: "internal",
        errorMessage: error instanceof Error ? error.message : String(error),
        summary: "Harness adapter execution failed",
        usageBasis: "per_run",
        clearSession: false,
      };
    } finally {
      clearInterval(watchdog);
      input.signal?.removeEventListener("abort", abortForCancellation);
    }

    if (stalled) {
      result = {
        ...result,
        exitCode: 1,
        timedOut: true,
        errorCode: "session_stalled",
        errorFamily: "transient_upstream",
        errorMessage: `No CLI progress for ${Math.round(stuckAfterMs / 60_000)} minutes; interrupted for resume`,
        summary: "CLI session stalled and was interrupted for resume",
      };
    }

    if (
      result.exitCode === 0 &&
      requiresRuntimeExecution(adapterType) &&
      actualRuntimeIdentity === undefined
    ) {
      result = {
        ...result,
        exitCode: 1,
        errorCode: "runtime_identity_missing",
        errorFamily: "internal",
        errorMessage: "Managed adapter did not execute through the selected runtime",
        summary: "Managed runtime execution was not observed",
      };
    }

    if (input.onExecuted) {
      try {
        await input.onExecuted(result);
      } catch (error) {
        persistenceFailure = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (persistenceFailure) {
      result = {
        ...result,
        exitCode: result.exitCode === 0 ? 1 : result.exitCode,
        errorCode: "evidence_persistence_failed",
        errorFamily: "internal",
        errorMessage: persistenceFailure.message,
        summary: "Required execution evidence could not be persisted",
      };
    }
    if (actualRuntimeIdentity) result = { ...result, runtimeIdentity: actualRuntimeIdentity };

    const status = terminalStatus(result, input.signal);
    await this.store.completeHarnessSession(session.id, result, status);
    await this.store.appendNextEvent({
      organizationId: input.plan.organizationId,
      attemptId: input.plan.attemptId,
      type: "harness.session.completed",
      payload: {
        harnessSessionId: session.id,
        providerSessionId: result.sessionId ?? observedProviderSessionId ?? null,
        status,
        exitCode: result.exitCode,
        runtimeIdentity: result.runtimeIdentity ?? null,
      },
    });
    await this.completeAttempt(input.plan.attemptId, status, input.signal);
    return result;
  }

  private async completeAttempt(
    attemptId: string,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted || status === "cancelled") {
      const requested = await this.store.requestCancelAttempt(attemptId);
      if (requested.status === "cancelling")
        await this.store.transitionAttempt(attemptId, "cancelled");
      return;
    }
    await this.store.transitionAttempt(attemptId, status);
  }

  private assertWorkspace(input: ExecuteHarnessPlanInput): void {
    if (input.workspace.attemptId !== input.plan.attemptId) {
      throw new Error("Execution plan and workspace attempt IDs must match");
    }
    if (input.workspace.status !== "ready") {
      throw new Error(`Execution workspace is not ready: ${input.workspace.status}`);
    }
  }
}

const MANAGED_ENV_BASELINE_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
] as const;

const MANAGED_AGENT_ENV_KEYS = new Set([
  "AASPAI_AGENT_ID",
  "AASPAI_ORGANIZATION_ID",
  "AASPAI_AGENT_NAME",
  "AASPAI_ADAPTER_TYPE",
  "AASPAI_RUN_ID",
  "AASPAI_SESSION_ID",
  "AASPAI_SESSION_DISPLAY_ID",
  "AASPAI_CWD",
  "AASPAI_PROTOCOL_VERSION",
]);

const MANAGED_OPENCODE_ENV_KEYS = new Set([
  "XDG_CONFIG_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_ALLOW_ALL_MODELS",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_PURE",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
]);

function managedEnvironmentBaseline(kind: ExecutionTarget["kind"]): Record<string, string> {
  if (kind !== "local") return {};
  return Object.fromEntries(
    MANAGED_ENV_BASELINE_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function managedAdapterEnvironment(
  candidate: Record<string, string> | undefined,
  adapterConfig: JsonObject,
): Record<string, string> {
  const configured =
    typeof adapterConfig.env === "object" &&
    adapterConfig.env !== null &&
    !Array.isArray(adapterConfig.env)
      ? new Set(Object.keys(adapterConfig.env))
      : new Set<string>();
  return Object.fromEntries(
    Object.entries(candidate ?? {}).filter(
      ([key]) =>
        MANAGED_AGENT_ENV_KEYS.has(key) ||
        MANAGED_OPENCODE_ENV_KEYS.has(key) ||
        configured.has(key),
    ),
  );
}

function requiresRuntimeExecution(adapter: AdapterType): boolean {
  return ["claude_local", "codex_local", "opencode_cli"].includes(adapter);
}

function resolveStuckAfterMs(config: JsonObject): number {
  const value = config.stuckAfterMs;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1_000 &&
    value <= 86_400_000
    ? value
    : DEFAULT_STUCK_AFTER_MS;
}

export function assertGovernedRuntimeIsolation(
  adapter: string,
  target: ExecutionTarget,
  governed: boolean,
): void {
  if (
    governed &&
    target.kind === "local" &&
    target.envPassthrough === true &&
    requiresRuntimeExecution(adapter as AdapterType)
  ) {
    throw new Error("Governed local CLI agents require a managed environment");
  }
}

export function assertRuntimeIdentity(
  requested: ExecutionTarget,
  workspacePath: string,
  actual: RunProcessResult["runtimeIdentity"],
): asserts actual is NonNullable<RunProcessResult["runtimeIdentity"]> {
  if (!actual) throw new Error("Selected runtime did not report its identity");
  if (actual.kind !== requested.kind) {
    throw new Error(`Runtime identity mismatch: requested ${requested.kind}, got ${actual.kind}`);
  }

  if (requested.kind === "local") {
    if (normalizeLocalPath(actual.cwd) !== normalizeLocalPath(workspacePath)) {
      throw new Error(
        `Runtime identity mismatch: requested local workspace ${workspacePath}, got ${actual.cwd}`,
      );
    }
    return;
  }

  if (requested.kind === "docker") {
    if (!actual.containerId) {
      throw new Error("Runtime identity mismatch: Docker execution did not report a container ID");
    }
    if (
      requested.remoteCwd &&
      normalizeRemotePath(actual.cwd) !== normalizeRemotePath(requested.remoteCwd)
    ) {
      throw new Error(
        `Runtime identity mismatch: requested Docker cwd ${requested.remoteCwd}, got ${actual.cwd}`,
      );
    }
    return;
  }

  if (requested.kind === "ssh") {
    const expectedConnection = `${requested.username}@${requested.host}:${requested.port}`;
    const expectedCwd = normalizeRemotePath(requested.remoteCwd);
    const actualCwd = normalizeRemotePath(actual.remoteCwd ?? actual.cwd);
    if (
      actual.host !== requested.host ||
      (actualCwd !== expectedCwd && !actualCwd.startsWith(`${expectedCwd}/`)) ||
      actual.connectionIdentity !== expectedConnection
    ) {
      throw new Error("Runtime identity mismatch: SSH target does not match the execution plan");
    }
    return;
  }

  const expectedLeaseId =
    typeof requested.metadata?.providerLeaseId === "string"
      ? requested.metadata.providerLeaseId
      : null;
  if (
    expectedLeaseId
      ? actual.connectionIdentity !== `${requested.provider}:${expectedLeaseId}`
      : !actual.connectionIdentity?.startsWith(`${requested.provider}:`)
  ) {
    throw new Error("Runtime identity mismatch: sandbox target does not match the execution plan");
  }
}

function normalizeLocalPath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeRemotePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
}

export function enforceRuntimeToolPolicy(
  adapter: AdapterType,
  adapterConfig: JsonObject,
  profile: ResolvedAgentProfile,
  tools?: AdapterExecutionContext["tools"],
): { adapterConfig: JsonObject; tools?: AdapterExecutionContext["tools"] } {
  const approvalRequired = profile.tools.filter(
    (decision) => decision.allowed && decision.requiresApproval,
  );
  if (approvalRequired.length > 0) {
    throw new Error(
      `Tool approval is required but no runtime approval broker is configured: ${approvalRequired
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }

  const allowed = new Set(
    profile.tools
      .filter((decision) => decision.allowed && decision.ready)
      .map(({ name }) => name.toLowerCase()),
  );
  const nativeAllowed = profile.tools
    .filter(
      (decision) =>
        decision.allowed && decision.ready && decision.tool?.description === "Harness-native tool",
    )
    .map(({ name }) => canonicalNativeTool(adapter, name));
  const maxSubAgentSpawns =
    typeof profile.inputs?.budget?.maxSubAgentSpawns === "number"
      ? profile.inputs.budget.maxSubAgentSpawns
      : 0;
  if (maxSubAgentSpawns > 0) {
    throw new Error(
      "Sub-agent spawning requires a runtime spawn broker; refusing an unenforceable positive limit",
    );
  }
  const boundedNativeAllowed = nativeAllowed.filter(
    (name) => !["task", "spawn_agent"].includes(name.toLowerCase()),
  );
  const guardedTools = tools
    ? {
        invoke: async (...args: Parameters<NonNullable<typeof tools>["invoke"]>) => {
          if (!allowed.has(args[0].toLowerCase())) {
            throw new Error(`Tool "${args[0]}" is denied by the resolved agent profile`);
          }
          return tools.invoke(...args);
        },
      }
    : undefined;

  if (adapter === "codex_local") {
    const nativeBundle = ["apply_patch", "shell", "web_search", "view_image"];
    if (nativeBundle.some((name) => !boundedNativeAllowed.includes(name))) {
      throw new Error("codex_local requires its complete sandboxed native tool bundle");
    }
    assertNoPolicyOverrides(adapterConfig.extraArgs, [
      "--sandbox",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ask-for-approval",
    ]);
    return {
      adapterConfig: {
        ...adapterConfig,
        sandbox: "workspace-write",
        approvalMode: "never",
      },
      tools: guardedTools,
    };
  }
  if (adapter === "claude_local") {
    assertNoPolicyOverrides(adapterConfig.extraArgs, [
      "--tools",
      "--allowedTools",
      "--disallowedTools",
      "--permission-mode",
      "--dangerously-skip-permissions",
    ]);
    return {
      adapterConfig: {
        ...adapterConfig,
        tools: boundedNativeAllowed,
        permissionMode: "default",
        dangerouslySkipPermissions: false,
      },
      tools: guardedTools,
    };
  }
  if (adapter === "opencode_cli") {
    return {
      adapterConfig: {
        ...adapterConfig,
        autoApprove: false,
        dangerouslySkipPermissions: false,
        disableProjectConfig: true,
        permissions: Object.fromEntries([
          ["*", "deny"],
          ...boundedNativeAllowed.map((name) => [name, "allow"]),
        ]),
      },
      tools: guardedTools,
    };
  }
  return { adapterConfig, tools: guardedTools };
}

function canonicalNativeTool(adapter: AdapterType, name: string): string {
  if (adapter !== "claude_local") return name.toLowerCase();
  const canonical = [
    "Bash",
    "Edit",
    "Glob",
    "Grep",
    "NotebookEdit",
    "Read",
    "Task",
    "WebFetch",
    "WebSearch",
    "Write",
  ];
  return canonical.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ?? name;
}

function assertNoPolicyOverrides(value: unknown, deniedFlags: string[]): void {
  if (
    Array.isArray(value) &&
    value.some(
      (entry) =>
        typeof entry === "string" &&
        deniedFlags.some((flag) => entry === flag || entry.startsWith(`${flag}=`)),
    )
  ) {
    throw new Error("Adapter extraArgs cannot override the resolved agent tool policy");
  }
}

function terminalStatus(
  result: AdapterExecutionResult,
  signal?: AbortSignal,
): "succeeded" | "failed" | "cancelled" | "timed_out" {
  if (signal?.aborted) return "cancelled";
  if (result.timedOut) return "timed_out";
  return result.exitCode === 0 ? "succeeded" : "failed";
}
