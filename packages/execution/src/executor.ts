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

const ATTEMPT_HEARTBEAT_INTERVAL_MS = 60_000;

export interface AutonomousExecutionInput {
  organizationId: string;
  workflowRunId: string;
  workItemId: string;
  agentId: string;
  harness: string;
  parentAttemptId?: string | null;
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
    let workItem = await this.store.getWorkItem(input.workItemId);
    if (!workItem) throw new Error(`Work item ${input.workItemId} not found`);
    if (workItem.organizationId !== input.organizationId)
      throw new Error("organization scope mismatch");
    const recovered = await this.store.reconcileTerminalHarnessAttempt(input.workItemId);
    if (recovered) {
      workItem = recovered.workItem;
      if (!["proposed", "ready"].includes(workItem.status)) {
        return { attempt: recovered.attempt, workItem };
      }
    }
    const suppliedAttempt = recovered?.attempt.id === input.attempt?.id ? undefined : input.attempt;
    const dispatched = suppliedAttempt
      ? { attempt: suppliedAttempt, created: false }
      : await this.store.dispatchWorkItem({
          workflowRunId: input.workflowRunId,
          workItemId: input.workItemId,
          agentId: input.agentId,
          harness: input.harness,
          parentAttemptId: input.parentAttemptId ?? null,
          organizationConcurrency: 1,
          projectConcurrency: 1,
          repositoryConcurrency: 1,
          agentConcurrency: 1,
        });
    if (!dispatched) throw new Error(`Work item ${input.workItemId} is not dispatchable`);
    const attempt =
      suppliedAttempt?.status === "running"
        ? suppliedAttempt
        : await this.store.startScheduledAttempt(dispatched.attempt.id);
    const workflowRun = await this.store.getWorkflowRun(input.workflowRunId);
    if (!workflowRun) throw new Error(`Workflow run ${input.workflowRunId} not found`);
    let stopHeartbeat: (() => Promise<void>) | undefined;
    let providerResult: AdapterExecutionResult | undefined;
    let status: "succeeded" | "failed" | "cancelled" | "timed_out";
    let usage: { tokens?: number; costUsd?: number } | undefined;
    try {
      stopHeartbeat = await startAttemptHeartbeat(this.store, attempt.id);
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
      await stopHeartbeat();
    } catch (error) {
      await stopHeartbeat?.().catch(() => undefined);
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

async function startAttemptHeartbeat(
  store: ExecutionStore,
  attemptId: string,
): Promise<() => Promise<void>> {
  if (!(await store.heartbeatAttempt(attemptId))) {
    throw new Error(`Agent attempt ${attemptId} is not active`);
  }
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let failure: unknown;
  let timer: NodeJS.Timeout | undefined;
  const heartbeat = () => {
    if (stopped || inFlight) return;
    inFlight = store
      .heartbeatAttempt(attemptId)
      .then((active) => {
        failure = undefined;
        if (!active) {
          stopped = true;
          if (timer) clearInterval(timer);
        }
      })
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        inFlight = null;
      });
  };
  timer = setInterval(heartbeat, ATTEMPT_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (inFlight) await inFlight;
    if (failure) throw failure;
  };
}
