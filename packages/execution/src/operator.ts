import { randomUUID } from "node:crypto";
import type {
  ControlDecision,
  ExecutionContext,
  OperatorRun,
  ProcessDefinition,
  ProcessStep,
} from "@aaspai/contracts/operator";
import { controlDecisionSchema, executionContextSchema } from "@aaspai/contracts/operator";
import {
  AutonomousWorkExecutor,
  type AutonomousExecutionInput as AutonomousWorkExecutorInput,
} from "./executor.js";
import { OperatorStateStore } from "./operator-store.js";
import type { ExecutionStore } from "./store.js";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}/${randomUUID()}`;

export interface StartProcessInput {
  context: ExecutionContext;
  operatorAgentId: string;
  scopeType: "goal" | "project" | "workflow" | "organization";
  scopeId: string;
  processBindingId?: string | null;
  definition: ProcessDefinition;
  goalId: string;
  projectId: string;
  milestoneId?: string | null;
  repositoryId: string;
  definitionRevisionId: string;
  sourceCommitSha?: string | null;
  idempotencyKey: string;
  parentWorkItemId?: string | null;
  parentAttemptId?: string | null;
  parentSessionId?: string | null;
  resolveAgent?: (step: ProcessStep) => Promise<string>;
}

export interface OperatorTickResult {
  run: OperatorRun;
  decision: ControlDecision | null;
}

export interface OperatorTickOptions {
  runProvider?: AutonomousWorkExecutorInput["runProvider"];
  /** The worker's resolved agent adapter. Never silently replace it with dry-run. */
  harness?: string;
  plan?: AutonomousWorkExecutorInput["plan"];
  workspace?: AutonomousWorkExecutorInput["workspace"];
}

export interface OperatorWorkItemExecutionInput {
  agentId: string;
  harness: string;
  runProvider: AutonomousWorkExecutorInput["runProvider"];
}

/** Durable, bounded operator control loop. It makes at most one decision per tick. */
export class OperatorService {
  private readonly state: OperatorStateStore;
  private readonly executor: AutonomousWorkExecutor;

  constructor(
    private readonly store: ExecutionStore,
    executor?: AutonomousWorkExecutor,
  ) {
    this.state = new OperatorStateStore(store.database);
    this.executor = executor ?? new AutonomousWorkExecutor(store);
  }

  async executeWorkItem(
    contextInput: ExecutionContext,
    workflowRunId: string,
    workItemId: string,
    input: OperatorWorkItemExecutionInput,
  ) {
    const context = executionContextSchema.parse(contextInput);
    const workItem = await this.store.getWorkItem(workItemId, context);
    if (!workItem) throw new Error(`Work item ${workItemId} not found`);
    if (workItem.workflowRunId !== workflowRunId)
      throw new Error("work item does not belong to workflow run");
    return this.executor.execute({
      organizationId: context.organizationId,
      workflowRunId,
      workItemId,
      agentId: input.agentId,
      harness: input.harness,
      runProvider: input.runProvider,
    });
  }

  async startProcess(
    input: StartProcessInput,
  ): Promise<{ run: OperatorRun; workflowRunId: string; workItemIds: string[] }> {
    const context = executionContextSchema.parse(input.context);
    const definition = await this.state.saveProcessDefinition(input.definition);
    const run = await this.state.createOperatorRun({
      id: `operator-run/${context.organizationId}/${input.scopeType}/${input.scopeId}`,
      organizationId: context.organizationId,
      operatorAgentId: input.operatorAgentId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      workflowRunId: null,
      status: "idle",
      observedStateVersion: 0,
      latestDecisionId: null,
      wakeAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const workflow = await this.store.createWorkflowRun({
      organizationId: context.organizationId,
      goalId: input.goalId,
      definitionRevisionId: input.definitionRevisionId,
      processDefinitionHash: definition.contentHash,
      sourceType: "operator",
      sourceId: run.id,
      idempotencyKey: input.idempotencyKey,
    });
    const items = new Map<string, string>();
    for (const step of definition.steps) {
      const assignedAgentId =
        step.agent ?? (input.resolveAgent ? await input.resolveAgent(step) : input.operatorAgentId);
      const item = await this.store.createWorkItem({
        organizationId: context.organizationId,
        goalId: input.goalId,
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        workflowRunId: workflow.id,
        milestoneId: input.milestoneId ?? null,
        processBindingId: input.processBindingId ?? null,
        parentWorkItemId: input.parentWorkItemId ?? null,
        assignedAgentId,
        alignmentRationale: `Process ${definition.id}@${definition.revision}, step ${step.id}`,
        title: step.id,
        description: step.prompt,
        definitionRevisionId: input.definitionRevisionId,
        sourceCommitSha: input.sourceCommitSha ?? null,
        maxAttempts: step.maxAttempts,
        workKind: step.workKind ?? "repository",
        deliveryMode: step.deliveryMode ?? (step.workKind === "general" ? "none" : "commit"),
        idempotencyKey: `${input.idempotencyKey}:${step.id}`,
        status: step.dependsOn.length === 0 ? "ready" : "proposed",
        governance: {
          verification: {
            required: Boolean(input.processBindingId),
            checkerAgentId: input.operatorAgentId,
            acceptanceCriteria: [
              {
                id: `${step.id}:acceptance`,
                description: step.acceptanceCriteria,
                required: true,
              },
            ],
            minEvidence: input.processBindingId ? 1 : 0,
          },
          approval: {
            required: step.approvalPolicy.required === true,
            actorType:
              step.approvalPolicy.actorType === "operator" ||
              step.approvalPolicy.actorType === "supervisor"
                ? step.approvalPolicy.actorType
                : "human",
            expiresAfterMs:
              typeof step.approvalPolicy.expiresAfterMs === "number"
                ? step.approvalPolicy.expiresAfterMs
                : null,
          },
        },
        metadata: {
          stepId: step.id,
          agent: step.agent,
          routingRule: step.routingRule,
          skills: step.skills,
          tools: step.tools,
          acceptanceCriteria: step.acceptanceCriteria,
          failureAction: step.failureAction,
          workKind: step.workKind,
          deliveryMode: step.deliveryMode,
          processBindingId: input.processBindingId ?? null,
          parentAttemptId: input.parentAttemptId ?? null,
          parentSessionId: input.parentSessionId ?? null,
        },
      });
      items.set(step.id, item.id);
    }
    for (const step of definition.steps) {
      for (const dependency of step.dependsOn) {
        await this.store.addWorkItemDependency(
          context.organizationId,
          items.get(step.id) as string,
          items.get(dependency) as string,
        );
      }
    }
    const evaluating = await this.state.updateOperatorRun(context, run.id, {
      workflowRunId: workflow.id,
      status: "evaluating",
      wakeAt: null,
    });
    await this.store.updateWorkflowRunStatus(workflow.id, "running");
    const startDecision = controlDecisionSchema.parse({
      id: id("decision"),
      organizationId: context.organizationId,
      operatorRunId: run.id,
      sequence: evaluating.observedStateVersion + 1,
      observedStateVersion: evaluating.observedStateVersion,
      idempotencyKey: `${run.id}:start_process:${workflow.id}`,
      action: "start_process",
      targetType: "workflow_run",
      targetId: workflow.id,
      parameters: { definitionId: definition.id, revision: definition.revision },
      rationale: "Process definition compiled and pinned to a workflow run",
      status: "proposed",
      createdAt: now(),
      appliedAt: null,
    });
    await this.state.applyDecision(context, (await this.state.proposeDecision(startDecision)).id);
    return {
      run: (await this.state.getOperatorRun(context, run.id)) as OperatorRun,
      workflowRunId: workflow.id,
      workItemIds: [...items.values()],
    };
  }

  async tick(
    contextInput: ExecutionContext,
    operatorRunId: string,
    options: OperatorTickOptions = {},
  ): Promise<OperatorTickResult> {
    const context = executionContextSchema.parse(contextInput);
    const lease = await this.state.acquireLease(context, operatorRunId);
    if (!lease) throw new Error("operator run is leased by another worker");
    try {
      const current = await this.state.getOperatorRun(context, operatorRunId);
      if (!current) throw new Error(`Operator run ${operatorRunId} not found`);
      if (["completed", "failed", "blocked"].includes(current.status))
        return { run: current, decision: null };
      await this.promoteReadyItems(context.organizationId, current.workflowRunId);
      const decision = await this.nextDecision(context, current);
      const accepted = await this.state.proposeDecision(decision);
      const applied = await this.state.applyDecision(context, accepted.id);
      if (!applied) throw new Error("operator decision was not applied");
      if (applied.action === "wait")
        await this.state.updateOperatorRun(context, current.id, {
          status: "waiting",
          wakeAt: typeof applied.parameters.wakeAt === "string" ? applied.parameters.wakeAt : null,
        });
      if (applied.action === "complete") {
        await this.state.updateOperatorRun(context, current.id, { status: "completed" });
        if (current.workflowRunId)
          await this.store.updateWorkflowRunStatus(current.workflowRunId, "succeeded");
      }
      if (applied.action === "escalate") {
        await this.state.createEscalation({
          id: id("manager-escalation"),
          organizationId: context.organizationId,
          operatorRunId: current.id,
          targetType: applied.targetType,
          targetId: applied.targetId,
          reason: applied.rationale,
          evidenceIds: [],
          status: "open",
          resolution: null,
          resolvedAt: null,
        });
        await this.state.updateOperatorRun(context, current.id, { status: "blocked" });
        if (current.workflowRunId)
          await this.store.updateWorkflowRunStatus(current.workflowRunId, "failed");
      }
      if (applied.action === "dispatch" && options.runProvider) {
        const workItem = await this.store.getWorkItem(applied.targetId ?? "", context);
        if (!workItem) throw new Error("dispatch target disappeared");
        const metadata = workItem.metadata;
        const agentId = workItem.assignedAgentId ?? current.operatorAgentId;
        const result = await this.executor.execute({
          organizationId: context.organizationId,
          workflowRunId: current.workflowRunId as string,
          workItemId: workItem.id,
          agentId,
          harness:
            options.harness ??
            (typeof metadata.harness === "string" ? metadata.harness : "opencode_local"),
          runProvider: options.runProvider,
          plan: options.plan,
          workspace: options.workspace,
        });
        if (result.workItem.status === "completed")
          await this.state.updateOperatorRun(context, current.id, {
            status: "evaluating",
            wakeAt: null,
          });
      }
      return {
        run: (await this.state.getOperatorRun(context, current.id)) as OperatorRun,
        decision: applied,
      };
    } finally {
      await this.state.releaseLease(context, lease.id);
    }
  }

  private async promoteReadyItems(
    organizationId: string,
    workflowRunId: string | null,
  ): Promise<void> {
    if (!workflowRunId) return;
    const items = (await this.store.listWorkItems(organizationId)).filter(
      (item) => item.workflowRunId === workflowRunId,
    );
    const statuses = new Map(items.map((item) => [item.id, item.status]));
    for (const item of items) {
      if (item.status !== "proposed") continue;
      const dependencies = await this.store.listWorkItemDependencies(item.id, {
        organizationId,
        actorId: "operator",
        correlationId: workflowRunId,
      });
      if (
        dependencies.every(
          (dependency) => statuses.get(dependency.dependsOnWorkItemId) === "completed",
        )
      ) {
        await this.store.updateWorkItemStatus(
          item.id,
          "ready",
          {},
          { organizationId, actorId: "operator", correlationId: workflowRunId },
        );
        statuses.set(item.id, "ready");
      }
    }
  }

  private async nextDecision(
    context: ExecutionContext,
    run: OperatorRun,
  ): Promise<ControlDecision> {
    const sequence = run.observedStateVersion + 1;
    if (!run.workflowRunId)
      return this.decision(run, context, sequence, "wait", "operator run has no workflow", {
        wakeAt: new Date(Date.now() + 1_000).toISOString(),
      });
    const items = (await this.store.listWorkItems(context.organizationId)).filter(
      (item) => item.workflowRunId === run.workflowRunId,
    );
    if (items.length > 0 && items.every((item) => item.status === "completed"))
      return this.decision(run, context, sequence, "complete", "all work items completed", {});
    const failed = items.find((item) => ["blocked", "failed", "cancelled"].includes(item.status));
    if (failed)
      return this.decision(
        run,
        context,
        sequence,
        "escalate",
        `manager work requires human review: ${failed.blockedReason ?? failed.status}`,
        { workItemId: failed.id },
      );
    const ready = items.find((item) => item.status === "ready");
    if (ready)
      return this.decision(run, context, sequence, "dispatch", "ready work item exists", {
        workItemId: ready.id,
      });
    return this.decision(
      run,
      context,
      sequence,
      "wait",
      "work is waiting on dependencies or evidence",
      { wakeAt: new Date(Date.now() + 30_000).toISOString() },
    );
  }

  private decision(
    run: OperatorRun,
    context: ExecutionContext,
    sequence: number,
    action: ControlDecision["action"],
    rationale: string,
    parameters: Record<string, unknown>,
  ): ControlDecision {
    return controlDecisionSchema.parse({
      id: id("decision"),
      organizationId: context.organizationId,
      operatorRunId: run.id,
      sequence,
      observedStateVersion: run.observedStateVersion,
      idempotencyKey: `${run.id}:${sequence}`,
      action,
      targetType: action === "dispatch" || action === "escalate" ? "work_item" : "operator_run",
      targetId: typeof parameters.workItemId === "string" ? parameters.workItemId : run.id,
      parameters,
      rationale,
      status: "proposed",
      createdAt: now(),
      appliedAt: null,
    });
  }
}
