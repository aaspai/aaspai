import type { ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type {
  AdapterExecutionResult,
  AdapterType,
  TranscriptEntry,
} from "@aaspai/contracts/harness";
import { adapterTypeSchema, HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { getAdapter } from "@aaspai/harness";
import type { ExecutionStore } from "./store.js";

export interface HarnessAgentInput {
  id: string;
  name: string;
  adapterType: AdapterType;
  adapterConfig: JsonObject;
  role?: string;
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
    const adapter = getAdapter(adapterType);
    const session = await this.store.createHarnessSession({
      organizationId: input.plan.organizationId,
      agentId: input.agent.id,
      adapter: adapterType,
      prompt: input.plan.prompt,
      runtime: { cwd: input.workspace.path },
      config: input.agent.adapterConfig,
    });
    await this.store.linkHarnessSession(input.plan.attemptId, session.id);
    await this.store.transitionAttempt(input.plan.attemptId, "preparing");

    let sessionEventSeq = 0;
    let executionEventSeq = 1;
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

    await this.store.transitionAttempt(input.plan.attemptId, "running");
    await this.store.appendEvent({
      organizationId: input.plan.organizationId,
      attemptId: input.plan.attemptId,
      type: "harness.session.started",
      payload: {
        harnessSessionId: session.id,
        adapter: adapterType,
        cwd: input.workspace.path,
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
          adapterConfig: input.agent.adapterConfig,
        },
        runtime: {},
        config: input.agent.adapterConfig,
        context: {
          cwd: input.workspace.path,
          prompt: input.plan.prompt,
          role: input.agent.role,
        },
        signal: input.signal,
        onLog: async (stream, chunk) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (!line) continue;
            await recordSessionEvent(stream === "stderr" ? "stderr" : "stdout", { text: line });
          }
        },
        onMeta: async (meta) => recordSessionEvent("system", { meta }),
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
      await this.store.transitionAttempt(attemptId, "cancelling");
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
    if (input.plan.target.kind !== "local") {
      throw new Error(
        `Execution plan target is not supported by the local harness runner: ${input.plan.target.kind}`,
      );
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
