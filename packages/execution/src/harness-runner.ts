import type { ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterType,
  TranscriptEntry,
} from "@aaspai/contracts/harness";
import { adapterTypeSchema, HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { getAdapter } from "@aaspai/harness";
import { resolveTarget } from "@aaspai/runtime";
import { assertHarnessExecutable, assertRuntimeReady } from "./capabilities.js";
import type { ExecutionStore } from "./store.js";

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
  agent: HarnessAgentInput;
  signal?: AbortSignal;
}

/** Executes a persisted plan through a registered provider adapter. */
export class HarnessExecutionPlanRunner {
  constructor(private readonly store: ExecutionStore) {}

  async run(input: ExecuteHarnessPlanInput): Promise<AdapterExecutionResult> {
    this.assertWorkspace(input);
    const adapterType = adapterTypeSchema.parse(input.plan.harness);
    assertHarnessExecutable(adapterType);
    await assertRuntimeReady(input.plan.target);
    const target = resolveTarget(input.plan.target);
    const targetInput = {
      ...input.plan.target,
      cwd: input.workspace.path,
    } as ExecutionPlan["target"];
    const adapter = getAdapter(adapterType);
    const adapterConfig = { ...input.agent.adapterConfig, ...input.plan.harnessConfig };
    const session = await this.store.createHarnessSession({
      organizationId: input.plan.organizationId,
      agentId: input.agent.id,
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
    let executionEventSeq = 1;
    let persistenceFailure: Error | undefined;
    let actualRuntimeIdentity: AdapterExecutionResult["runtimeIdentity"];
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
    await this.store.appendEvent({
      organizationId: input.plan.organizationId,
      attemptId: input.plan.attemptId,
      type: "harness.session.started",
      payload: {
        harnessSessionId: session.id,
        adapter: adapterType,
        cwd: input.workspace.path,
        requestedRuntime: input.plan.target,
      },
      seq: executionEventSeq++,
    });

    let result: AdapterExecutionResult;
    try {
      result = await adapter.execute({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        runId: input.plan.attemptId,
        organizationId: input.plan.organizationId,
        agent: {
          id: input.agent.id,
          organizationId: input.plan.organizationId,
          name: input.agent.name,
          adapterType,
          adapterConfig,
        },
        runtime: {
          sessionId: input.agent.resumeSessionId,
          sessionParams: {
            resume: Boolean(input.agent.resumeSessionId),
            fork: input.agent.forkSession === true,
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
          role: input.agent.role,
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
              timeoutMs:
                options.timeoutMs === undefined || input.plan.timeoutMs === null
                  ? (options.timeoutMs ?? undefined)
                  : Math.min(options.timeoutMs, input.plan.timeoutMs),
              onLog: async (stream, chunk) => {
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
            actualRuntimeIdentity = result.runtimeIdentity;
            return result;
          },
        },
        signal: input.signal,
        onLog: async (stream, chunk) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (!line) continue;
            if (stream === "stdout") {
              try {
                const parsed = JSON.parse(line) as { kind?: string } & Record<string, unknown>;
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
        tools: input.agent.tools,
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
    await this.store.appendEvent({
      organizationId: input.plan.organizationId,
      attemptId: input.plan.attemptId,
      type: "harness.session.completed",
      payload: {
        harnessSessionId: session.id,
        providerSessionId: result.sessionId ?? null,
        status,
        exitCode: result.exitCode,
        runtimeIdentity: result.runtimeIdentity ?? null,
      },
      seq: executionEventSeq,
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

function terminalStatus(
  result: AdapterExecutionResult,
  signal?: AbortSignal,
): "succeeded" | "failed" | "cancelled" | "timed_out" {
  if (signal?.aborted) return "cancelled";
  if (result.timedOut) return "timed_out";
  return result.exitCode === 0 ? "succeeded" : "failed";
}
