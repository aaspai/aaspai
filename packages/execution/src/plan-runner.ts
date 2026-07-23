import type { AgentAttempt, ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type { RunProcessResult } from "@aaspai/contracts/runtime";
import { pickTarget, type RuntimeTarget } from "@aaspai/runtime";
import type { ExecutionStore } from "./store.js";

export interface ExecutePlanInput {
  plan: ExecutionPlan;
  workspace: ExecutionWorkspace;
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  stdin?: string;
}

export type RuntimeTargetPicker = (target: ExecutionPlan["target"]) => RuntimeTarget;

/** Runs a persisted plan only inside the workspace assigned to its attempt. */
export class ExecutionPlanRunner {
  constructor(
    private readonly store: ExecutionStore,
    private readonly targetPicker: RuntimeTargetPicker = pickTarget,
  ) {}

  async run(input: ExecutePlanInput): Promise<RunProcessResult> {
    this.assertWorkspace(input);
    await this.store.transitionAttempt(input.plan.attemptId, "preparing");

    try {
      await this.store.transitionAttempt(input.plan.attemptId, "running");
      const target = this.targetPicker(input.plan.target);
      const targetInput = {
        ...input.plan.target,
        cwd: input.workspace.path,
      } as ExecutionPlan["target"];
      const result = await target.run(targetInput, {
        command: input.command,
        args: [...(input.args ?? [])],
        cwd: input.workspace.path,
        env: input.env,
        stdin: input.stdin,
        timeoutMs: input.plan.timeoutMs ?? undefined,
      });
      await this.store.transitionAttempt(input.plan.attemptId, outcomeStatus(result));
      return result;
    } catch (error) {
      await this.store.transitionAttempt(input.plan.attemptId, "failed");
      throw error;
    }
  }

  private assertWorkspace(input: ExecutePlanInput): void {
    if (input.workspace.attemptId !== input.plan.attemptId) {
      throw new Error("Execution plan and workspace attempt IDs must match");
    }
    if (input.workspace.status !== "ready") {
      throw new Error(`Execution workspace is not ready: ${input.workspace.status}`);
    }
    if (input.plan.target.kind !== "local") {
      throw new Error(
        `Execution plan target is not supported by the local runner: ${input.plan.target.kind}`,
      );
    }
  }
}

function outcomeStatus(result: RunProcessResult): AgentAttempt["status"] {
  if (result.timedOut) return "timed_out";
  return result.exitCode === 0 ? "succeeded" : "failed";
}
