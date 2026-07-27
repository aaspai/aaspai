import { randomUUID } from "node:crypto";
import type {
  AuthorityEdge,
  ControlRisk,
  Delegation,
  Escalation,
  RoutingDecision,
  RoutingRequest,
} from "@aaspai/contracts/company-control";
import {
  authorityEdgeSchema,
  delegationSchema,
  escalationSchema,
  routingDecisionSchema,
  routingRequestSchema,
} from "@aaspai/contracts/company-control";
import {
  and,
  authorityEdges,
  delegations,
  departments,
  eq,
  escalations,
  routingDecisions,
  type SqliteDb,
  serviceAgents,
} from "@aaspai/db";

export interface CompanyWorkItemInput {
  organizationId: string;
  goalId: string;
  projectId: string;
  repositoryId: string;
  workflowRunId?: string | null;
  definitionRevisionId: string;
  title: string;
  description: string;
  branchName?: string | null;
  sourceCommitSha?: string | null;
  priority: number;
  maxAttempts: number;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  governance: Record<string, unknown>;
}

export interface CompanyWorkItemPort {
  createWorkItem(input: CompanyWorkItemInput): Promise<{ id: string }>;
}

export interface DelegateWorkInput extends RoutingRequest {
  goalId: string;
  projectId: string;
  repositoryId: string;
  definitionRevisionId: string;
  workflowRunId?: string | null;
  branchName?: string | null;
  sourceCommitSha?: string | null;
  maxAttempts?: number;
  governance?: Record<string, unknown>;
}

export class CompanyControlPlaneError extends Error {}

export class CompanyControlPlaneService {
  constructor(
    private readonly db: SqliteDb,
    private readonly workItems?: CompanyWorkItemPort,
  ) {}

  async setAuthorityEdge(input: {
    organizationId: string;
    fromAgentId: string;
    toAgentId: string;
    relation: AuthorityEdge["relation"];
  }): Promise<AuthorityEdge> {
    if (input.fromAgentId === input.toAgentId)
      throw new CompanyControlPlaneError("authority edges cannot target the same agent");
    const edges = await this.listAuthorityEdges(input.organizationId);
    if (["reports_to", "manages"].includes(input.relation)) {
      const next = {
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        relation: input.relation,
      };
      if (hasPath(edges, next.fromAgentId, next.toAgentId, ["reports_to", "manages"])) {
        throw new CompanyControlPlaneError("authority edge would create a cycle");
      }
    }
    const timestamp = now();
    const edge = authorityEdgeSchema.parse({
      id: `authority/${randomUUID()}`,
      organizationId: input.organizationId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      relation: input.relation,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.insert(authorityEdges).values(edge).onConflictDoNothing().run();
    const existing = await this.db
      .select()
      .from(authorityEdges)
      .where(
        and(
          eq(authorityEdges.organizationId, input.organizationId),
          eq(authorityEdges.fromAgentId, input.fromAgentId),
          eq(authorityEdges.toAgentId, input.toAgentId),
          eq(authorityEdges.relation, input.relation),
        ),
      )
      .limit(1);
    return authorityEdgeSchema.parse(existing[0] ?? edge);
  }

  async listAuthorityEdges(organizationId: string): Promise<AuthorityEdge[]> {
    const rows = await this.db
      .select()
      .from(authorityEdges)
      .where(eq(authorityEdges.organizationId, organizationId));
    return rows.map((row) => authorityEdgeSchema.parse(row));
  }

  async route(input: RoutingRequest): Promise<RoutingDecision> {
    const request = routingRequestSchema.parse(input);
    const existing = await this.db
      .select()
      .from(routingDecisions)
      .where(
        and(
          eq(routingDecisions.organizationId, request.organizationId),
          eq(routingDecisions.idempotencyKey, request.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return toRoutingDecision(existing[0]);

    const edges = await this.listAuthorityEdges(request.organizationId);
    const candidate = await this.selectCandidate(request);
    const path =
      candidate && request.requestedByAgentId
        ? findPath(edges, request.requestedByAgentId, candidate.agentId, [
            "manages",
            "may_delegate_to",
            "reports_to",
          ])
        : candidate
          ? [candidate.agentId]
          : [];
    if (candidate && (!request.requestedByAgentId || path)) {
      return this.persistRouting(
        request,
        "routed",
        candidate.agentId,
        candidate.departmentId,
        path ?? [candidate.agentId],
        null,
        `Routed to ${candidate.agentId}`,
      );
    }

    const escalation = await this.createEscalation({
      organizationId: request.organizationId,
      subjectType: "routing",
      subjectId: request.idempotencyKey,
      requestedByAgentId: request.requestedByAgentId,
      risk: request.risk,
      reason: candidate ? "requester lacks delegation authority" : "no eligible service agent",
      context: { title: request.title, capability: request.capability },
    });
    return this.persistRouting(
      request,
      candidate ? "rejected" : "escalated",
      null,
      request.departmentId,
      [],
      escalation.id,
      candidate
        ? "Requester is not authorized to delegate to the selected agent"
        : "No eligible service agent is available",
    );
  }

  async delegate(input: DelegateWorkInput): Promise<Delegation> {
    if (!this.workItems)
      throw new CompanyControlPlaneError("WorkItem dispatcher is not configured");
    const {
      goalId: _goalId,
      projectId: _projectId,
      repositoryId: _repositoryId,
      definitionRevisionId: _definitionRevisionId,
      workflowRunId: _workflowRunId,
      branchName: _branchName,
      sourceCommitSha: _sourceCommitSha,
      maxAttempts: _maxAttempts,
      governance: _governance,
      ...routingInput
    } = input;
    const request = routingRequestSchema.parse(routingInput);
    const existing = await this.findDelegation(request.organizationId, request.idempotencyKey);
    if (existing) return existing;
    const decision = await this.route(request);
    if (decision.status !== "routed" || !decision.selectedAgentId) {
      throw new CompanyControlPlaneError(`delegation cannot proceed: ${decision.reason}`);
    }
    const timestamp = now();
    let workItemId: string;
    try {
      const workItem = await this.workItems.createWorkItem({
        organizationId: request.organizationId,
        goalId: input.goalId,
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        workflowRunId: input.workflowRunId,
        definitionRevisionId: input.definitionRevisionId,
        title: request.title,
        description: request.description,
        branchName: input.branchName,
        sourceCommitSha: input.sourceCommitSha,
        priority: request.priority,
        maxAttempts: input.maxAttempts ?? 1,
        idempotencyKey: request.idempotencyKey,
        metadata: {
          routedBy: request.requestedByAgentId,
          assignedAgentId: decision.selectedAgentId,
          risk: request.risk,
          capability: request.capability,
        },
        governance: input.governance ?? {},
      });
      workItemId = workItem.id;
    } catch (error) {
      const delegation = await this.persistDelegation({
        request,
        targetAgentId: decision.selectedAgentId,
        authorityPath: decision.authorityPath,
        status: "failed",
        workItemId: null,
        reason: error instanceof Error ? error.message : String(error),
        timestamp,
      });
      throw new CompanyControlPlaneError(`delegation failed: ${delegation.reason}`);
    }
    return this.persistDelegation({
      request,
      targetAgentId: decision.selectedAgentId,
      authorityPath: decision.authorityPath,
      status: "created",
      workItemId,
      reason: `WorkItem ${workItemId} created for ${decision.selectedAgentId}`,
      timestamp,
    });
  }

  async createEscalation(input: {
    organizationId: string;
    subjectType: Escalation["subjectType"];
    subjectId: string;
    requestedByAgentId?: string | null;
    targetAgentId?: string | null;
    risk: ControlRisk;
    reason: string;
    context?: Record<string, unknown>;
  }): Promise<Escalation> {
    const existing = await this.db
      .select()
      .from(escalations)
      .where(
        and(
          eq(escalations.organizationId, input.organizationId),
          eq(escalations.subjectType, input.subjectType),
          eq(escalations.subjectId, input.subjectId),
        ),
      )
      .limit(1);
    if (existing[0]) return toEscalation(existing[0]);
    const edges = await this.listAuthorityEdges(input.organizationId);
    const escalationTarget =
      input.targetAgentId ??
      (input.requestedByAgentId
        ? (edges.find(
            (edge) =>
              edge.fromAgentId === input.requestedByAgentId &&
              ["must_escalate_to", "reports_to"].includes(edge.relation),
          )?.toAgentId ?? null)
        : null);
    const path = input.requestedByAgentId
      ? findPath(edges, input.requestedByAgentId, escalationTarget ?? "", [
          "must_escalate_to",
          "reports_to",
        ])
      : null;
    const targetAgentId = escalationTarget ?? path?.at(-1) ?? null;
    const timestamp = now();
    const escalation = escalationSchema.parse({
      id: `escalation/${input.organizationId}/${input.subjectType}/${safeId(input.subjectId)}`,
      organizationId: input.organizationId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      requestedByAgentId: input.requestedByAgentId ?? null,
      targetAgentId,
      risk: input.risk,
      reason: input.reason,
      context: input.context ?? {},
      authorityPath: path ?? [],
      status: "open",
      resolvedBy: null,
      resolution: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    try {
      await this.db.insert(escalations).values(toEscalationInsert(escalation)).run();
    } catch (error) {
      if (!isUniqueError(error)) throw error;
      const retry = await this.db
        .select()
        .from(escalations)
        .where(
          and(
            eq(escalations.organizationId, input.organizationId),
            eq(escalations.subjectType, input.subjectType),
            eq(escalations.subjectId, input.subjectId),
          ),
        )
        .limit(1);
      if (retry[0]) return toEscalation(retry[0]);
    }
    return escalation;
  }

  async acknowledgeEscalation(organizationId: string, id: string): Promise<Escalation> {
    return this.updateEscalation(organizationId, id, "acknowledged");
  }

  async listEscalations(organizationId: string): Promise<Escalation[]> {
    const rows = await this.db
      .select()
      .from(escalations)
      .where(eq(escalations.organizationId, organizationId));
    return rows.map(toEscalation);
  }

  async resolveEscalation(
    organizationId: string,
    id: string,
    resolvedBy: string,
    resolution: string,
  ): Promise<Escalation> {
    if (!resolution.trim()) throw new CompanyControlPlaneError("resolution is required");
    const timestamp = now();
    const rows = await this.db
      .select()
      .from(escalations)
      .where(and(eq(escalations.organizationId, organizationId), eq(escalations.id, id)))
      .limit(1);
    if (!rows[0]) throw new CompanyControlPlaneError("escalation not found");
    await this.db
      .update(escalations)
      .set({ status: "resolved", resolvedBy, resolution, updatedAt: timestamp })
      .where(and(eq(escalations.organizationId, organizationId), eq(escalations.id, id)))
      .run();
    return toEscalation({
      ...rows[0],
      status: "resolved",
      resolvedBy,
      resolution,
      updatedAt: timestamp,
    });
  }

  private async updateEscalation(
    organizationId: string,
    id: string,
    status: "acknowledged",
  ): Promise<Escalation> {
    const rows = await this.db
      .select()
      .from(escalations)
      .where(and(eq(escalations.organizationId, organizationId), eq(escalations.id, id)))
      .limit(1);
    if (!rows[0]) throw new CompanyControlPlaneError("escalation not found");
    const updatedAt = now();
    await this.db
      .update(escalations)
      .set({ status, updatedAt })
      .where(and(eq(escalations.organizationId, organizationId), eq(escalations.id, id)))
      .run();
    return toEscalation({ ...rows[0], status, updatedAt });
  }

  private async selectCandidate(request: RoutingRequest) {
    const rows = await this.db
      .select()
      .from(serviceAgents)
      .where(
        and(
          eq(serviceAgents.organizationId, request.organizationId),
          eq(serviceAgents.status, "active"),
        ),
      );
    const departmentsById = new Map(
      (
        await this.db
          .select()
          .from(departments)
          .where(eq(departments.organizationId, request.organizationId))
      ).map((row) => [row.id, row]),
    );
    const candidates = rows
      .map((row) => ({ row, metadata: parseJson(row.metadataJson) }))
      .filter(({ row, metadata }) => {
        if (request.targetAgentId && row.agentId !== request.targetAgentId) return false;
        if (request.departmentId && row.departmentId !== request.departmentId) return false;
        if (row.departmentId && departmentsById.get(row.departmentId)?.status !== "active")
          return false;
        if (request.requiredRole && !arrayHas(metadata.roles, request.requiredRole)) return false;
        if (request.capability && !arrayHas(metadata.capabilities, request.capability))
          return false;
        return true;
      })
      .sort(
        (a, b) =>
          a.row.failureCount - b.row.failureCount || a.row.agentId.localeCompare(b.row.agentId),
      );
    const candidate = candidates[0]?.row;
    return candidate ? { agentId: candidate.agentId, departmentId: candidate.departmentId } : null;
  }

  private async persistRouting(
    request: RoutingRequest,
    status: RoutingDecision["status"],
    selectedAgentId: string | null,
    departmentId: string | null,
    authorityPath: string[],
    escalationId: string | null,
    reason: string,
  ): Promise<RoutingDecision> {
    const decision = routingDecisionSchema.parse({
      id: `route/${request.organizationId}/${safeId(request.idempotencyKey)}`,
      organizationId: request.organizationId,
      idempotencyKey: request.idempotencyKey,
      status,
      selectedAgentId,
      departmentId,
      authorityPath,
      escalationId,
      reason,
      createdAt: now(),
    });
    try {
      await this.db.insert(routingDecisions).values(toRoutingDecisionInsert(decision)).run();
    } catch (error) {
      if (!isUniqueError(error)) throw error;
      const existing = await this.db
        .select()
        .from(routingDecisions)
        .where(
          and(
            eq(routingDecisions.organizationId, request.organizationId),
            eq(routingDecisions.idempotencyKey, request.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing[0]) return toRoutingDecision(existing[0]);
    }
    return decision;
  }

  private async findDelegation(organizationId: string, idempotencyKey: string) {
    const rows = await this.db
      .select()
      .from(delegations)
      .where(
        and(
          eq(delegations.organizationId, organizationId),
          eq(delegations.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toDelegation(rows[0]) : null;
  }

  private async persistDelegation(input: {
    request: RoutingRequest;
    targetAgentId: string;
    authorityPath: string[];
    status: Delegation["status"];
    workItemId: string | null;
    reason: string;
    timestamp: string;
  }): Promise<Delegation> {
    const delegation = delegationSchema.parse({
      id: `delegation/${input.request.organizationId}/${safeId(input.request.idempotencyKey)}`,
      organizationId: input.request.organizationId,
      idempotencyKey: input.request.idempotencyKey,
      requestedByAgentId: input.request.requestedByAgentId,
      targetAgentId: input.targetAgentId,
      workItemId: input.workItemId,
      authorityPath: input.authorityPath,
      status: input.status,
      reason: input.reason,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    });
    try {
      await this.db.insert(delegations).values(toDelegationInsert(delegation)).run();
    } catch (error) {
      if (!isUniqueError(error)) throw error;
      const existing = await this.findDelegation(
        input.request.organizationId,
        input.request.idempotencyKey,
      );
      if (existing) return existing;
    }
    return delegation;
  }
}

function findPath(
  edges: readonly AuthorityEdge[],
  from: string,
  to: string,
  relations: readonly AuthorityEdge["relation"][],
): string[] | null {
  if (!from || !to) return null;
  const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }];
  const visited = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.id === to) return current.path;
    for (const edge of edges) {
      const next =
        edge.fromAgentId === current.id && relations.includes(edge.relation)
          ? edge.toAgentId
          : edge.relation === "reports_to" &&
              relations.includes("reports_to") &&
              edge.toAgentId === current.id
            ? edge.fromAgentId
            : null;
      if (next && !visited.has(next)) {
        visited.add(next);
        queue.push({ id: next, path: [...current.path, next] });
      }
    }
  }
  return null;
}

function hasPath(
  edges: readonly AuthorityEdge[],
  from: string,
  to: string,
  relations: readonly AuthorityEdge["relation"][],
): boolean {
  return findPath(edges, to, from, relations) !== null;
}

function toRoutingDecision(row: typeof routingDecisions.$inferSelect): RoutingDecision {
  const { authorityPathJson, ...portable } = row;
  return routingDecisionSchema.parse({ ...portable, authorityPath: parseArray(authorityPathJson) });
}
function toDelegation(row: typeof delegations.$inferSelect): Delegation {
  const { authorityPathJson, ...portable } = row;
  return delegationSchema.parse({ ...portable, authorityPath: parseArray(authorityPathJson) });
}
function toEscalation(row: typeof escalations.$inferSelect): Escalation {
  const { contextJson, authorityPathJson, ...portable } = row;
  return escalationSchema.parse({
    ...portable,
    context: parseJson(contextJson),
    authorityPath: parseArray(authorityPathJson),
  });
}
const toRoutingDecisionInsert = (row: RoutingDecision) => ({
  id: row.id,
  organizationId: row.organizationId,
  idempotencyKey: row.idempotencyKey,
  status: row.status,
  selectedAgentId: row.selectedAgentId,
  departmentId: row.departmentId,
  authorityPathJson: JSON.stringify(row.authorityPath),
  escalationId: row.escalationId,
  reason: row.reason,
  createdAt: row.createdAt,
});
const toDelegationInsert = (row: Delegation) => ({
  id: row.id,
  organizationId: row.organizationId,
  idempotencyKey: row.idempotencyKey,
  requestedByAgentId: row.requestedByAgentId,
  targetAgentId: row.targetAgentId,
  workItemId: row.workItemId,
  authorityPathJson: JSON.stringify(row.authorityPath),
  status: row.status,
  reason: row.reason,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
function toEscalationInsert(row: Escalation) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    requestedByAgentId: row.requestedByAgentId,
    targetAgentId: row.targetAgentId,
    risk: row.risk,
    reason: row.reason,
    contextJson: JSON.stringify(row.context),
    authorityPathJson: JSON.stringify(row.authorityPath),
    status: row.status,
    resolvedBy: row.resolvedBy,
    resolution: row.resolution,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
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
function arrayHas(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}
function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 240);
}
const now = () => new Date().toISOString();
function isUniqueError(error: unknown): boolean {
  return /unique|constraint/i.test(String(error));
}
