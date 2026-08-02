import { createHash } from "node:crypto";
import {
  and,
  authorityEdges,
  autonomyProposals,
  eq,
  executionApprovals,
  executionEscalations,
  executionGovernanceEvents,
  executionWorkItems,
  gt,
  inArray,
  knowledgeProposals,
  loopOutputs,
  type SqliteDb,
  serviceAgents,
  workflowRuns,
} from "@aaspai/db";
import { CompanyControlPlaneService } from "./control-plane";
import { CompanyOperationsError, CompanyOperationsService } from "./index";

export interface FileAgentRelation {
  id: string;
  reportsTo?: string | null;
  manages?: string[];
  peers?: string[];
  metadata?: Record<string, unknown>;
}

export interface LoopMetrics {
  loopId: string;
  runs: number;
  successfulRuns: number;
  failedRuns: number;
  successRate: number;
  outputs: number;
  completedActions: number;
  valueRate: number;
  feedback: number;
  falsePositives: number;
  falsePositiveRate: number;
}

export interface LoopReadiness {
  metrics: LoopMetrics;
  score: number;
  eligibleFor: "L2" | "L3" | null;
  retire: boolean;
  reasons: string[];
}

export interface HumanInboxItem {
  id: string;
  kind:
    | "approval"
    | "manager_escalation"
    | "escalation"
    | "autonomy_proposal"
    | "knowledge_proposal";
  status: string;
  title: string;
  detail: string;
  createdAt: string;
  targetId: string | null;
}

/**
 * Reconciles Git-defined organization data into the operational database and
 * derives loop governance from existing execution records.
 */
export class OperationalGovernanceService {
  constructor(private readonly db: SqliteDb) {}

  async reconcileAgentDefinitions(
    organizationId: string,
    definitions: readonly FileAgentRelation[],
  ): Promise<{ serviceAgents: number; authorityEdges: number }> {
    const ids = new Set(definitions.map((definition) => definition.id));
    if (ids.size !== definitions.length) throw new CompanyOperationsError("duplicate agent id");
    for (const definition of definitions) {
      if (!definition.id.startsWith("agent/"))
        throw new CompanyOperationsError(`invalid agent id: ${definition.id}`);
      for (const related of [
        ...(definition.reportsTo ? [definition.reportsTo] : []),
        ...(definition.manages ?? []),
        ...(definition.peers ?? []),
      ]) {
        if (!ids.has(related))
          throw new CompanyOperationsError(`${definition.id} references missing ${related}`);
        if (related === definition.id)
          throw new CompanyOperationsError(`${definition.id} cannot reference itself`);
      }
    }
    assertAcyclic(definitions);

    const operations = new CompanyOperationsService(this.db);
    for (const definition of definitions) {
      await operations.registerServiceAgent({
        organizationId,
        agentId: definition.id,
        metadata: { ...definition.metadata, definitionManaged: true },
      });
    }

    const existingAgents = await this.db
      .select()
      .from(serviceAgents)
      .where(eq(serviceAgents.organizationId, organizationId));
    const definitionManagedIds = new Set(
      existingAgents
        .filter((row) => parseJson(row.metadataJson).definitionManaged === true)
        .map((row) => row.agentId),
    );
    const timestamp = new Date().toISOString();
    for (const row of existingAgents) {
      const metadata = parseJson(row.metadataJson);
      if (metadata.definitionManaged === true && !ids.has(row.agentId)) {
        await this.db
          .update(serviceAgents)
          .set({ status: "retired", updatedAt: timestamp })
          .where(eq(serviceAgents.id, row.id))
          .run();
      }
    }

    const currentEdges = await this.db
      .select()
      .from(authorityEdges)
      .where(eq(authorityEdges.organizationId, organizationId));
    for (const edge of currentEdges) {
      if (
        (edge.relation === "reports_to" || edge.relation === "manages") &&
        (definitionManagedIds.has(edge.fromAgentId) || definitionManagedIds.has(edge.toAgentId))
      ) {
        await this.db.delete(authorityEdges).where(eq(authorityEdges.id, edge.id)).run();
      }
    }

    const control = new CompanyControlPlaneService(this.db);
    const managers = new Map<string, string>();
    for (const definition of definitions) {
      if (definition.reportsTo) {
        managers.set(definition.id, definition.reportsTo);
      }
      for (const managed of definition.manages ?? []) {
        const current = managers.get(managed);
        if (current && current !== definition.id)
          throw new CompanyOperationsError(`${managed} has conflicting managers`);
        managers.set(managed, definition.id);
      }
    }
    for (const [agentId, managerId] of managers) {
      await control.setAuthorityEdge({
        organizationId,
        fromAgentId: agentId,
        toAgentId: managerId,
        relation: "reports_to",
      });
    }
    return { serviceAgents: definitions.length, authorityEdges: managers.size };
  }

  async recordLoopFeedback(input: {
    organizationId: string;
    loopId: string;
    outputId: string;
    verdict: "valuable" | "false_positive" | "neutral";
    actorId: string;
    note?: string;
  }): Promise<void> {
    if (!input.loopId.startsWith("loop/")) throw new CompanyOperationsError("invalid loop id");
    const output = await this.db
      .select({ id: loopOutputs.id })
      .from(loopOutputs)
      .where(
        and(
          eq(loopOutputs.id, input.outputId),
          eq(loopOutputs.organizationId, input.organizationId),
          eq(loopOutputs.loopId, input.loopId),
        ),
      )
      .limit(1);
    if (!output[0]) throw new CompanyOperationsError("loop output not found");
    const feedbackId = `governance/loop-feedback/${createHash("sha256")
      .update(`${input.organizationId}\0${input.outputId}\0${input.actorId}`)
      .digest("hex")}`;
    await this.db
      .insert(executionGovernanceEvents)
      .values({
        id: feedbackId,
        organizationId: input.organizationId,
        workItemId: null,
        attemptId: null,
        action: "loop_feedback",
        decision: input.verdict,
        reason: input.note ?? "",
        metadataJson: JSON.stringify({
          loopId: input.loopId,
          outputId: input.outputId,
          actorId: input.actorId,
        }),
        occurredAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: executionGovernanceEvents.id,
        set: {
          decision: input.verdict,
          reason: input.note ?? "",
          occurredAt: new Date().toISOString(),
        },
      })
      .run();
  }

  async getLoopMetrics(
    organizationId: string,
    loopId: string,
    since = new Date(Date.now() - 30 * 86_400_000),
  ): Promise<LoopMetrics> {
    const sinceIso = since.toISOString();
    const runs = await this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.organizationId, organizationId),
          eq(workflowRuns.sourceType, "loop"),
          eq(workflowRuns.sourceId, loopId),
          gt(workflowRuns.createdAt, sinceIso),
        ),
      );
    const runIds = runs.map((run) => run.id);
    const outputs = runIds.length
      ? await this.db
          .select()
          .from(loopOutputs)
          .where(
            and(
              eq(loopOutputs.organizationId, organizationId),
              eq(loopOutputs.loopId, loopId),
              gt(loopOutputs.createdAt, sinceIso),
            ),
          )
      : [];
    const actions = runIds.length
      ? await this.db
          .select()
          .from(executionWorkItems)
          .where(
            and(
              eq(executionWorkItems.organizationId, organizationId),
              inArray(executionWorkItems.workflowRunId, runIds),
            ),
          )
      : [];
    const feedbackRows = await this.db
      .select()
      .from(executionGovernanceEvents)
      .where(
        and(
          eq(executionGovernanceEvents.organizationId, organizationId),
          eq(executionGovernanceEvents.action, "loop_feedback"),
          gt(executionGovernanceEvents.occurredAt, sinceIso),
        ),
      );
    const feedback = feedbackRows.filter((row) => parseJson(row.metadataJson).loopId === loopId);
    const successfulRuns = runs.filter((run) =>
      ["completed", "succeeded"].includes(run.status),
    ).length;
    const failedRuns = runs.filter((run) => run.status === "failed").length;
    const completedActions = actions.filter((item) =>
      ["completed", "approved", "delivered"].includes(item.status),
    ).length;
    const valuableFeedback = feedback.filter((row) => row.decision === "valuable").length;
    const falsePositives = feedback.filter((row) => row.decision === "false_positive").length;
    return {
      loopId,
      runs: runs.length,
      successfulRuns,
      failedRuns,
      successRate: ratio(successfulRuns, runs.length),
      outputs: outputs.length,
      completedActions,
      valueRate: ratio(
        completedActions + valuableFeedback,
        Math.max(outputs.length, feedback.length),
      ),
      feedback: feedback.length,
      falsePositives,
      falsePositiveRate: ratio(falsePositives, feedback.length),
    };
  }

  async assessLoop(
    organizationId: string,
    loopId: string,
    currentLevel: "L1" | "L2" | "L3",
  ): Promise<LoopReadiness> {
    const metrics = await this.getLoopMetrics(organizationId, loopId);
    const threshold =
      currentLevel === "L1"
        ? { runs: 10, success: 0.9, falsePositive: 0.1, value: 0.1, next: "L2" as const }
        : currentLevel === "L2"
          ? { runs: 25, success: 0.95, falsePositive: 0.05, value: 0.5, next: "L3" as const }
          : null;
    const reasons: string[] = [];
    if (threshold) {
      if (metrics.runs < threshold.runs) reasons.push(`needs ${threshold.runs} runs`);
      if (metrics.successRate < threshold.success) reasons.push("success rate is too low");
      if (metrics.feedback < 5) reasons.push("needs 5 human feedback samples");
      if (metrics.falsePositiveRate > threshold.falsePositive)
        reasons.push("false-positive rate is too high");
      if (metrics.valueRate < threshold.value) reasons.push("value rate is too low");
    }
    const retire =
      metrics.runs >= 10 &&
      (metrics.valueRate === 0 || (metrics.feedback >= 5 && metrics.falsePositiveRate >= 0.5));
    if (retire) reasons.push("retirement threshold reached");
    const score = Math.round(
      Math.min(1, metrics.runs / (threshold?.runs ?? 25)) * 25 +
        metrics.successRate * 30 +
        (1 - metrics.falsePositiveRate) * 25 +
        Math.min(1, metrics.valueRate) * 20,
    );
    return {
      metrics,
      score,
      eligibleFor: threshold && reasons.length === 0 ? threshold.next : null,
      retire,
      reasons,
    };
  }

  async getHumanInbox(organizationId: string): Promise<HumanInboxItem[]> {
    const [approvals, managerEscalations, escalations, autonomy, knowledge] = await Promise.all([
      this.db
        .select()
        .from(executionApprovals)
        .where(
          and(
            eq(executionApprovals.organizationId, organizationId),
            eq(executionApprovals.status, "requested"),
          ),
        ),
      this.db
        .select()
        .from(executionEscalations)
        .where(
          and(
            eq(executionEscalations.organizationId, organizationId),
            eq(executionEscalations.status, "open"),
          ),
        ),
      new CompanyControlPlaneService(this.db).listEscalations(organizationId),
      this.db
        .select()
        .from(autonomyProposals)
        .where(
          and(
            eq(autonomyProposals.organizationId, organizationId),
            eq(autonomyProposals.status, "proposed"),
          ),
        ),
      this.db
        .select()
        .from(knowledgeProposals)
        .where(
          and(
            eq(knowledgeProposals.organizationId, organizationId),
            eq(knowledgeProposals.status, "proposed"),
          ),
        ),
    ]);
    return [
      ...approvals.map((row) => ({
        id: row.id,
        kind: "approval" as const,
        status: row.status,
        title: "Execution approval",
        detail: row.reason,
        createdAt: row.requestedAt,
        targetId: row.workItemId,
      })),
      ...managerEscalations.map((row) => ({
        id: row.id,
        kind: "manager_escalation" as const,
        status: row.status,
        title: "Manager escalation",
        detail: row.reason,
        createdAt: row.createdAt,
        targetId: row.targetId,
      })),
      ...escalations
        .filter((row) => row.status === "open" || row.status === "acknowledged")
        .map((row) => ({
          id: row.id,
          kind: "escalation" as const,
          status: row.status,
          title: `${row.subjectType} escalation`,
          detail: row.reason,
          createdAt: row.createdAt,
          targetId: row.subjectId,
        })),
      ...autonomy.map((row) => ({
        id: row.id,
        kind: "autonomy_proposal" as const,
        status: row.status,
        title: "Autonomy proposal",
        detail: row.rationale,
        createdAt: row.createdAt,
        targetId: row.targetId,
      })),
      ...knowledge.map((row) => ({
        id: row.id,
        kind: "knowledge_proposal" as const,
        status: row.status,
        title: "Knowledge proposal",
        detail: row.summary,
        createdAt: row.createdAt,
        targetId: row.targetPath,
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getWeeklyDigest(organizationId: string) {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const loopIds = [
      ...new Set(
        (
          await this.db
            .select()
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.organizationId, organizationId),
                eq(workflowRuns.sourceType, "loop"),
                gt(workflowRuns.createdAt, since.toISOString()),
              ),
            )
        )
          .map((run) => run.sourceId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    return {
      since: since.toISOString(),
      inbox: await this.getHumanInbox(organizationId),
      loops: await Promise.all(
        loopIds.map((loopId) => this.getLoopMetrics(organizationId, loopId, since)),
      ),
    };
  }
}

function assertAcyclic(definitions: readonly FileAgentRelation[]): void {
  const manager = new Map(definitions.map((definition) => [definition.id, definition.reportsTo]));
  for (const definition of definitions) {
    for (const managed of definition.manages ?? []) {
      const current = manager.get(managed);
      if (current && current !== definition.id)
        throw new CompanyOperationsError(`${managed} has conflicting managers`);
      manager.set(managed, definition.id);
    }
  }
  for (const definition of definitions) {
    const seen = new Set<string>();
    let current: string | null | undefined = definition.id;
    while (current) {
      if (seen.has(current)) throw new CompanyOperationsError("agent relations contain a cycle");
      seen.add(current);
      current = manager.get(current);
    }
  }
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
