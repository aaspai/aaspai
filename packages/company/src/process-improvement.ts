import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeReviewInput } from "@aaspai/contracts";
import {
  companyControlEvents,
  companyProfiles,
  eq,
  executionWorkItems,
  goals,
  loops,
  objectiveMeasurements,
  projects,
  type SqliteDb,
  wakeups,
} from "@aaspai/db";
import { createKnowledgeCurator } from "@aaspai/knowledge";
import { createLocalMemoryProvider } from "@aaspai/memory";

export type ProcessImprovementEvaluation = {
  createdProposalIds: string[];
  skipped: number;
};

/** Turns durable delivery evidence into reviewable, never-auto-applied process improvements. */
export class ProcessImprovementService {
  constructor(private readonly db: SqliteDb) {}

  async evaluate(input: {
    organizationId: string;
    actorId: string;
    staleAfterDays?: number;
  }): Promise<ProcessImprovementEvaluation> {
    const now = new Date().toISOString();
    const [projectRows, workRows, goalRows, measurementRows] = await Promise.all([
      this.db.select().from(projects).where(eq(projects.organizationId, input.organizationId)),
      this.db
        .select()
        .from(executionWorkItems)
        .where(eq(executionWorkItems.organizationId, input.organizationId)),
      this.db.select().from(goals).where(eq(goals.organizationId, input.organizationId)),
      this.db
        .select()
        .from(objectiveMeasurements)
        .where(eq(objectiveMeasurements.organizationId, input.organizationId)),
    ]);
    const candidates = [
      ...projectRows
        .filter((project) => ["at_risk", "critical"].includes(project.healthStatus))
        .map((project) => ({
          key: `project-${project.id}`,
          title: `Improve delivery process for ${project.title}`,
          content: `Project ${project.title} is marked ${project.healthStatus}. Review milestones, ownership, and process bindings before changing the operating playbook.`,
          targetPath: `.aaspai/knowledge/process-improvements/project-${project.id}.md`,
          projectId: project.id,
          goalId: project.goalId,
          relatedId: project.id,
        })),
      ...workRows
        .filter((work) => ["blocked", "failed"].includes(work.status))
        .map((work) => ({
          key: `work-${work.id}`,
          title: `Prevent repeat ${work.status} work: ${work.title}`,
          content: `Work item ${work.title} is ${work.status}${work.blockedReason ? `: ${work.blockedReason}` : ""}. Capture the prerequisite, owner handoff, or verification rule that would prevent recurrence.`,
          targetPath: `.aaspai/knowledge/process-improvements/work-${work.id}.md`,
          projectId: work.projectId,
          goalId: work.goalId,
          relatedId: work.id,
        })),
      ...staleGoals(goalRows, measurementRows, input.staleAfterDays ?? 14).map((goal) => ({
        key: `objective-${goal.id}`,
        title: `Add an objective measurement cadence for ${goal.title}`,
        content: `Objective ${goal.title} has no recent measurement. Define a metric owner, source, and review cadence so portfolio health is evidence-based.`,
        targetPath: `.aaspai/knowledge/process-improvements/objective-${goal.id}.md`,
        projectId: null,
        goalId: goal.id,
        relatedId: goal.id,
      })),
    ];
    const staleGoalIds = new Set(
      staleGoals(goalRows, measurementRows, input.staleAfterDays ?? 14).map((goal) => goal.id),
    );
    if (staleGoalIds.size) {
      await Promise.all(
        projectRows
          .filter((project) => staleGoalIds.has(project.goalId) && project.status !== "completed")
          .map((project) =>
            this.db
              .update(projects)
              .set({ healthStatus: "at_risk", updatedAt: now })
              .where(eq(projects.id, project.id))
              .run(),
          ),
      );
    }
    const curator = createKnowledgeCurator(this.db);
    const existing = await curator.listProposals(input.organizationId);
    const activePaths = new Set(
      existing
        .filter((proposal) => ["proposed", "under_review", "accepted"].includes(proposal.status))
        .map((proposal) => proposal.targetPath),
    );
    const memory = createLocalMemoryProvider(this.db);
    const createdProposalIds: string[] = [];
    for (const candidate of candidates.slice(0, 50)) {
      if (activePaths.has(candidate.targetPath)) continue;
      const sourceId = stableId("evaluation", `${input.organizationId}:${candidate.key}`);
      const record = await memory.ingest({
        organizationId: input.organizationId,
        kind: "observation",
        title: candidate.title,
        content: candidate.content,
        scope: {
          organizationId: input.organizationId,
          projectId: candidate.projectId,
          goalId: candidate.goalId,
          workItemId: candidate.key.startsWith("work-") ? candidate.relatedId : null,
          agentId: null,
          topic: "process-improvement",
        },
        sensitivity: "internal",
        provenance: {
          sourceType: "manual",
          sourceId,
          capturedAt: now,
          actorId: input.actorId,
          extractor: "process-improvement",
        },
        evidence: [{ kind: "manual", sourceId, label: "Automated delivery evaluation", uri: null }],
        retention: { policy: "long", expiresAt: null },
        tags: ["process-improvement", "evaluation"],
        relatedIds: [candidate.relatedId],
        metadata: { evaluator: "process-improvement" },
      });
      const proposal = await curator.createProposal({
        id: stableId("proposal", `${input.organizationId}:${candidate.key}`),
        organizationId: input.organizationId,
        title: candidate.title,
        summary: candidate.content,
        content: candidate.content,
        targetPath: candidate.targetPath,
        knowledgeType: "process-improvement",
        tags: ["process-improvement"],
        sourceMemoryIds: [record.id],
        factIds: [],
        provenance: {
          sourceType: "manual",
          sourceId,
          capturedAt: now,
          actorId: input.actorId,
          extractor: "process-improvement",
        },
        impactSummary: "Requires human review before becoming a Blueprint change request.",
        status: "proposed",
        reviewedBy: null,
        reviewReason: null,
        reviewedAt: null,
      });
      createdProposalIds.push(proposal.id);
      activePaths.add(candidate.targetPath);
    }
    return { createdProposalIds, skipped: candidates.length - createdProposalIds.length };
  }

  async review(input: KnowledgeReviewInput) {
    const result = await createKnowledgeCurator(this.db).reviewProposal(input);
    const profile = await this.db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, input.organizationId))
      .limit(1);
    const now = new Date().toISOString();
    const loopId = `loop/company-control/${input.organizationId}`;
    this.db.transaction((tx) => {
      tx.insert(companyControlEvents)
        .values({
          id: randomUUID(),
          organizationId: input.organizationId,
          actorId: input.actorId,
          action: "review_process_improvement",
          targetType: "knowledge_proposal",
          targetId: input.proposalId,
          correlationId: input.proposalId,
          occurredAt: now,
          metadataJson: JSON.stringify({ action: input.action, reason: input.reason }),
        })
        .run();
      tx.insert(loops)
        .values({
          id: loopId,
          organizationId: input.organizationId,
          patternId: "company-control",
          configJson: "{}",
          gateJson: "{}",
          budgetJson: "{}",
          scheduleJson: "{}",
          paused: false,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      tx.insert(wakeups)
        .values({
          id: randomUUID(),
          organizationId: input.organizationId,
          loopId,
          source: "event",
          triggerDetail: "process-improvement-review",
          reason: `Process improvement ${input.action}`,
          agentId: profile[0]?.operatorAgentId ?? profile[0]?.ceoAgentId ?? null,
          payloadJson: JSON.stringify({ proposalId: input.proposalId, action: input.action }),
          status: "queued",
          idempotencyKey: `process-improvement-review:${input.proposalId}:${input.action}`,
          requestedAt: now,
          requestedByActorId: input.actorId,
          requestedByActorType: "user",
        })
        .onConflictDoNothing()
        .run();
    });
    return result;
  }
}

function staleGoals<T extends { id: string; updatedAt: string }>(
  rows: T[],
  measurements: Array<{ goalId: string; observedAt: string }>,
  staleAfterDays: number,
): T[] {
  const latest = new Map<string, number>();
  for (const measurement of measurements) {
    latest.set(
      measurement.goalId,
      Math.max(latest.get(measurement.goalId) ?? 0, Date.parse(measurement.observedAt)),
    );
  }
  const cutoff = Date.now() - staleAfterDays * 86_400_000;
  return rows.filter((goal) => (latest.get(goal.id) ?? Date.parse(goal.updatedAt)) < cutoff);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
