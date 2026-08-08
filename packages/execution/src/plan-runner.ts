import type { AgentAttempt, ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type { RunProcessResult } from "@aaspai/contracts/runtime";
import { assertRuntimeReady } from "./capabilities.js";
import { createManagedRuntimeBoundary, type ManagedRuntimeBoundary } from "./runtime-boundary.js";
import type { ExecutionStore } from "./store.js";

export interface ExecutePlanInput {
  plan: ExecutionPlan;
  workspace: ExecutionWorkspace;
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
}

export type RuntimeBoundaryFactory = (
  target: ExecutionPlan["target"],
  cwd: string,
) => Promise<ManagedRuntimeBoundary>;

/** Runs a persisted plan only inside the workspace assigned to its attempt. */
export class ExecutionPlanRunner {
  constructor(
    private readonly store: ExecutionStore,
    private readonly runtimeFactory: RuntimeBoundaryFactory = createManagedRuntimeBoundary,
  ) {}

  async run(input: ExecutePlanInput): Promise<RunProcessResult> {
    this.assertWorkspace(input);
    await assertRuntimeReady(input.plan.target);
    await this.store.transitionAttempt(input.plan.attemptId, "preparing");

    try {
      await this.store.transitionAttempt(input.plan.attemptId, "running");
      const runtime = await this.runtimeFactory(input.plan.target, input.workspace.path);
      let executionEventSeq = 1;
      let rawOutputSeq = 0;
      await this.store.appendEvent({
        organizationId: input.plan.organizationId,
        attemptId: input.plan.attemptId,
        type: "attempt.started",
        payload: {
          command: input.command,
          args: [...(input.args ?? [])],
          cwd: input.workspace.path,
        },
        seq: executionEventSeq,
      });
      let result: RunProcessResult;
      try {
        result = await runtime.execution.run({
          command: input.command,
          args: [...(input.args ?? [])],
          cwd: input.workspace.path,
          env: input.env,
          stdin: input.stdin,
          signal: input.signal,
          timeoutMs: input.plan.timeoutMs ?? undefined,
          onLog: async (stream, chunk) => {
            await this.store.appendRawOutput({
              organizationId: input.plan.organizationId,
              attemptId: input.plan.attemptId,
              ts: new Date().toISOString(),
              stream,
              chunk,
              seq: ++rawOutputSeq,
            });
            await this.store.appendEvent({
              organizationId: input.plan.organizationId,
              attemptId: input.plan.attemptId,
              type: "process.output",
              payload: { stream, chunk },
              seq: ++executionEventSeq,
            });
          },
        });
      } finally {
        await runtime.close();
      }
      await this.store.appendEvent({
        organizationId: input.plan.organizationId,
        attemptId: input.plan.attemptId,
        type: "process.completed",
        payload: {
          exitCode: result.exitCode,
          signal: result.signal ?? null,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          runtimeIdentity: result.runtimeIdentity ?? null,
        },
        seq: ++executionEventSeq,
      });
      await this.completeAttempt(input.plan.attemptId, outcomeStatus(result), input.signal);
      return result;
    } catch (error) {
      if (input.signal?.aborted) {
        await this.completeAttempt(input.plan.attemptId, "cancelled", input.signal);
      } else {
        await this.store.transitionAttempt(input.plan.attemptId, "failed");
      }
      throw error;
    }
  }

  private async completeAttempt(
    attemptId: string,
    status: AgentAttempt["status"],
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

  private assertWorkspace(input: ExecutePlanInput): void {
    if (input.workspace.attemptId !== input.plan.attemptId) {
      throw new Error("Execution plan and workspace attempt IDs must match");
    }
    if (input.workspace.status !== "ready") {
      throw new Error(`Execution workspace is not ready: ${input.workspace.status}`);
    }
  }
}

function outcomeStatus(result: RunProcessResult): AgentAttempt["status"] {
  if (result.timedOut) return "timed_out";
  return result.exitCode === 0 ? "succeeded" : "failed";
}
