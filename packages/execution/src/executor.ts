import type {
  AgentAttempt,
  ExecutionPlan,
  ExecutionWorkItem,
  ExecutionWorkspace,
  WorkflowRun,
} from "@aaspai/contracts/execution";
import type { AdapterExecutionResult } from "@aaspai/contracts/harness";
import { type HarnessAgentInput, HarnessExecutionPlanRunner } from "./harness-runner.js";
import type { ExecutionStore } from "./store.js";

export interface AutonomousExecutionInput {
  organizationId: string;
  workflowRunId: string;
  workItemId: string;
  agentId: string;
  harness: string;
  attempt?: AgentAttempt;
  plan?: ExecutionPlan;
  workspace?: ExecutionWorkspace;
  agent?: HarnessAgentInput;
  runProvider?: (input: {
    attempt: AgentAttempt;
    workItem: ExecutionWorkItem;
    workflowRun: WorkflowRun;
  }) => Promise<
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | {
        status: "succeeded" | "failed" | "cancelled" | "timed_out";
        usage?: { tokens?: number; costUsd?: number };
      }
  >;
}

export interface AutonomousExecutionResult {
  attempt: AgentAttempt;
  workItem: ExecutionWorkItem;
  providerResult?: AdapterExecutionResult;
}

/** The only Layer Five entry point allowed to advance a WorkItem into execution. */
export class AutonomousWorkExecutor {
  constructor(
    private readonly store: ExecutionStore,
    private readonly harnessRunner = new HarnessExecutionPlanRunner(store),
  ) {}

  async execute(input: AutonomousExecutionInput): Promise<AutonomousExecutionResult> {
    const workItem = await this.store.getWorkItem(input.workItemId);
    if (!workItem) throw new Error(`Work item ${input.workItemId} not found`);
    if (workItem.organizationId !== input.organizationId)
      throw new Error("organization scope mismatch");
    const dispatched = input.attempt
      ? { attempt: input.attempt, created: false }
      : await this.store.dispatchWorkItem({
          workflowRunId: input.workflowRunId,
          workItemId: input.workItemId,
          agentId: input.agentId,
          harness: input.harness,
          organizationConcurrency: 1,
          projectConcurrency: 1,
          repositoryConcurrency: 1,
          agentConcurrency: 1,
        });
    if (!dispatched) throw new Error(`Work item ${input.workItemId} is not dispatchable`);
    const attempt =
      input.attempt?.status === "running"
        ? input.attempt
        : await this.store.startScheduledAttempt(dispatched.attempt.id);
    const workflowRun = await this.store.getWorkflowRun(input.workflowRunId);
    if (!workflowRun) throw new Error(`Workflow run ${input.workflowRunId} not found`);
    let providerResult: AdapterExecutionResult | undefined;
    let status: "succeeded" | "failed" | "cancelled" | "timed_out";
    let usage: { tokens?: number; costUsd?: number } | undefined;
    try {
      if (input.runProvider) {
        const providerOutcome = await input.runProvider({ attempt, workItem, workflowRun });
        if (typeof providerOutcome === "string") {
          status = providerOutcome;
        } else {
          status = providerOutcome.status;
          usage = providerOutcome.usage;
        }
      } else {
        if (!input.plan || !input.workspace)
          throw new Error("immutable plan and workspace are required");
        providerResult = await this.harnessRunner.run({
          plan: input.plan,
          workspace: input.workspace,
          agent: input.agent,
        });
        status = providerResult.timedOut
          ? "timed_out"
          : providerResult.exitCode === 0
            ? "succeeded"
            : "failed";
      }
    } catch (error) {
      await this.store.completeScheduledAttempt({
        attemptId: attempt.id,
        status: "failed",
        error: String(error),
      });
      throw error;
    }
    const completed = await this.store.completeScheduledAttempt({
      attemptId: attempt.id,
      status,
      usage,
    });
    return { attempt: completed.attempt, workItem: completed.workItem, providerResult };
  }
}
