import { randomUUID } from "node:crypto";
import {
  type AutonomyLevel,
  type AutonomyProposal,
  autonomyProposalSchema,
  type CompanyExportBundle,
  type CompanyOperationsOverview,
  companyExportBundleSchema,
  companyOperationsOverviewSchema,
  type Department,
  type DepartmentMember,
  departmentMemberSchema,
  departmentSchema,
  type ServiceAgent,
  serviceAgentSchema,
} from "@aaspai/contracts";
import {
  and,
  autonomyProposals,
  departmentMembers,
  departments,
  eq,
  type SqliteDb,
  serviceAgents,
} from "@aaspai/db";

export interface CreateDepartmentInput {
  organizationId: string;
  name: string;
  description?: string;
  managerAgentId?: string | null;
}

export interface RegisterServiceAgentInput {
  organizationId: string;
  agentId: string;
  departmentId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateAutonomyProposalInput {
  organizationId: string;
  targetType: AutonomyProposal["targetType"];
  targetId: string;
  fromLevel: AutonomyLevel;
  toLevel: AutonomyLevel;
  rationale: string;
  evidence?: Record<string, unknown>;
  proposedBy: string;
}

export class CompanyOperationsError extends Error {}

export class CompanyOperationsService {
  constructor(private readonly db: SqliteDb) {}

  async getOverview(organizationId: string): Promise<CompanyOperationsOverview> {
    const [departmentRows, memberRows, serviceRows, proposalRows] = await Promise.all([
      this.db.select().from(departments).where(eq(departments.organizationId, organizationId)),
      this.db
        .select()
        .from(departmentMembers)
        .where(eq(departmentMembers.organizationId, organizationId)),
      this.db.select().from(serviceAgents).where(eq(serviceAgents.organizationId, organizationId)),
      this.db
        .select()
        .from(autonomyProposals)
        .where(eq(autonomyProposals.organizationId, organizationId)),
    ]);
    return companyOperationsOverviewSchema.parse({
      organizationId,
      departments: departmentRows.map(toDepartment),
      members: memberRows.map(toMember),
      serviceAgents: serviceRows.map(toServiceAgent),
      autonomyProposals: proposalRows.map(toProposal),
    });
  }

  async createDepartment(input: CreateDepartmentInput): Promise<Department> {
    const createdAt = now();
    const department = departmentSchema.parse({
      id: input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        ? `department/${input.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "")}`
        : makeId("department"),
      organizationId: input.organizationId,
      name: input.name,
      description: input.description ?? "",
      managerAgentId: input.managerAgentId ?? null,
      createdAt,
      updatedAt: createdAt,
    });
    try {
      await this.db.insert(departments).values(toDepartmentInsert(department)).run();
    } catch (error) {
      throw new CompanyOperationsError(`department already exists: ${String(error)}`);
    }
    if (department.managerAgentId) {
      await this.setDepartmentMember({
        organizationId: department.organizationId,
        departmentId: department.id,
        agentId: department.managerAgentId,
        role: "manager",
      });
    }
    return department;
  }

  async setDepartmentMember(input: {
    organizationId: string;
    departmentId: string;
    agentId: string;
    role?: DepartmentMember["role"];
  }): Promise<DepartmentMember> {
    const department = await this.getDepartment(input.organizationId, input.departmentId);
    if (!department) throw new CompanyOperationsError("department not found");
    const timestamp = now();
    const member = departmentMemberSchema.parse({
      departmentId: input.departmentId,
      organizationId: input.organizationId,
      agentId: input.agentId,
      role: input.role ?? "member",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db
      .insert(departmentMembers)
      .values(toMemberInsert(member))
      .onConflictDoUpdate({
        target: [departmentMembers.departmentId, departmentMembers.agentId],
        set: { role: member.role, updatedAt: timestamp },
      })
      .run();
    if (member.role === "manager") {
      await this.db
        .update(departments)
        .set({ managerAgentId: member.agentId, updatedAt: timestamp })
        .where(
          and(
            eq(departments.id, department.id),
            eq(departments.organizationId, input.organizationId),
          ),
        )
        .run();
    }
    return member;
  }

  async registerServiceAgent(input: RegisterServiceAgentInput): Promise<ServiceAgent> {
    const existing = await this.db
      .select()
      .from(serviceAgents)
      .where(
        and(
          eq(serviceAgents.organizationId, input.organizationId),
          eq(serviceAgents.agentId, input.agentId),
        ),
      )
      .limit(1);
    const timestamp = now();
    if (existing[0]) {
      await this.db
        .update(serviceAgents)
        .set({
          departmentId: input.departmentId ?? existing[0].departmentId,
          metadataJson: JSON.stringify(input.metadata ?? parseJson(existing[0].metadataJson)),
          status: existing[0].status === "retired" ? "retired" : "active",
          heartbeatAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(serviceAgents.id, existing[0].id))
        .run();
      return toServiceAgent({
        ...existing[0],
        departmentId: input.departmentId ?? existing[0].departmentId,
        metadataJson: JSON.stringify(input.metadata ?? parseJson(existing[0].metadataJson)),
        status: existing[0].status === "retired" ? "retired" : "active",
        heartbeatAt: timestamp,
        updatedAt: timestamp,
      });
    }
    const agent = serviceAgentSchema.parse({
      id: makeId("service-agent"),
      organizationId: input.organizationId,
      agentId: input.agentId,
      departmentId: input.departmentId ?? null,
      status: "active",
      heartbeatAt: timestamp,
      lastRunAt: null,
      failureCount: 0,
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.insert(serviceAgents).values(toServiceAgentInsert(agent)).run();
    return agent;
  }

  async transitionServiceAgent(
    organizationId: string,
    id: string,
    status: Extract<ServiceAgent["status"], "active" | "paused" | "retired">,
  ): Promise<ServiceAgent> {
    const rows = await this.db
      .select()
      .from(serviceAgents)
      .where(eq(serviceAgents.id, id))
      .limit(1);
    const current = rows[0];
    if (!current || current.organizationId !== organizationId)
      throw new CompanyOperationsError("service agent not found");
    if (current.status === "retired" && status !== "retired")
      throw new CompanyOperationsError("retired service agents cannot resume");
    const updatedAt = now();
    await this.db
      .update(serviceAgents)
      .set({ status, updatedAt })
      .where(eq(serviceAgents.id, id))
      .run();
    return toServiceAgent({ ...current, status, updatedAt });
  }

  async heartbeatServiceAgent(
    organizationId: string,
    id: string,
    lastRunAt?: string,
  ): Promise<ServiceAgent> {
    const rows = await this.db
      .select()
      .from(serviceAgents)
      .where(eq(serviceAgents.id, id))
      .limit(1);
    const current = rows[0];
    if (!current || current.organizationId !== organizationId)
      throw new CompanyOperationsError("service agent not found");
    if (current.status === "retired")
      throw new CompanyOperationsError("retired service agents cannot heartbeat");
    const updatedAt = now();
    await this.db
      .update(serviceAgents)
      .set({
        status: "active",
        heartbeatAt: updatedAt,
        lastRunAt: lastRunAt ?? current.lastRunAt,
        updatedAt,
      })
      .where(eq(serviceAgents.id, id))
      .run();
    return toServiceAgent({
      ...current,
      status: "active",
      heartbeatAt: updatedAt,
      lastRunAt: lastRunAt ?? current.lastRunAt,
      updatedAt,
    });
  }

  async reconcileServiceAgents(
    organizationId: string,
    staleAfterMs: number,
    at = new Date(),
  ): Promise<ServiceAgent[]> {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0)
      throw new CompanyOperationsError("staleAfterMs must be positive");
    const cutoff = new Date(at.getTime() - staleAfterMs).toISOString();
    const rows = await this.db
      .select()
      .from(serviceAgents)
      .where(
        and(eq(serviceAgents.organizationId, organizationId), eq(serviceAgents.status, "active")),
      );
    const stale = rows.filter((row) => row.heartbeatAt !== null && row.heartbeatAt < cutoff);
    for (const row of stale)
      await this.db
        .update(serviceAgents)
        .set({ status: "stale", updatedAt: at.toISOString() })
        .where(eq(serviceAgents.id, row.id))
        .run();
    return stale.map((row) =>
      toServiceAgent({ ...row, status: "stale", updatedAt: at.toISOString() }),
    );
  }

  async createAutonomyProposal(input: CreateAutonomyProposalInput): Promise<AutonomyProposal> {
    if (input.targetType === "agent" && !input.targetId.startsWith("agent/"))
      throw new CompanyOperationsError("agent targets must use agent/<id>");
    if (input.targetType === "loop" && !input.targetId.startsWith("loop/"))
      throw new CompanyOperationsError("loop targets must use loop/<id>");
    const levels: AutonomyLevel[] = ["L0", "L1", "L2", "L3"];
    if (
      input.fromLevel === input.toLevel ||
      Math.abs(levels.indexOf(input.fromLevel) - levels.indexOf(input.toLevel)) !== 1
    )
      throw new CompanyOperationsError("autonomy proposals must move one level at a time");
    const timestamp = now();
    const proposal = autonomyProposalSchema.parse({
      id: makeId("autonomy-proposal"),
      ...input,
      evidence: input.evidence ?? {},
      status: "proposed",
      reviewedBy: null,
      reviewReason: "",
      reviewedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.insert(autonomyProposals).values(toProposalInsert(proposal)).run();
    return proposal;
  }

  async decideAutonomyProposal(
    organizationId: string,
    id: string,
    decision: "approved" | "rejected",
    reviewedBy: string,
    reviewReason = "",
  ): Promise<AutonomyProposal> {
    const rows = await this.db
      .select()
      .from(autonomyProposals)
      .where(eq(autonomyProposals.id, id))
      .limit(1);
    const current = rows[0];
    if (!current || current.organizationId !== organizationId)
      throw new CompanyOperationsError("autonomy proposal not found");
    if (current.status !== "proposed")
      throw new CompanyOperationsError("autonomy proposal has already been decided");
    const reviewedAt = now();
    await this.db
      .update(autonomyProposals)
      .set({ status: decision, reviewedBy, reviewReason, reviewedAt, updatedAt: reviewedAt })
      .where(eq(autonomyProposals.id, id))
      .run();
    return toProposal({
      ...current,
      status: decision,
      reviewedBy,
      reviewReason,
      reviewedAt,
      updatedAt: reviewedAt,
    });
  }

  async exportCompany(organizationId: string): Promise<CompanyExportBundle> {
    const overview = await this.getOverview(organizationId);
    return companyExportBundleSchema.parse({
      kind: "aaspai.company",
      protocolVersion: 1,
      exportedAt: now(),
      departments: overview.departments.map(({ organizationId: _, ...row }) => row),
      members: overview.members.map(({ organizationId: _, ...row }) => row),
      serviceAgents: overview.serviceAgents.map(({ organizationId: _, ...row }) => row),
      autonomyProposals: overview.autonomyProposals.map(({ organizationId: _, ...row }) => row),
    });
  }

  validateImport(bundle: unknown): CompanyExportBundle {
    const parsed = companyExportBundleSchema.parse(bundle);
    const departmentIds = new Set(parsed.departments.map((department) => department.id));
    if (parsed.members.some((member) => !departmentIds.has(member.departmentId))) {
      throw new CompanyOperationsError("company bundle contains a member for a missing department");
    }
    if (
      parsed.serviceAgents.some(
        (agent) => agent.departmentId && !departmentIds.has(agent.departmentId),
      )
    ) {
      throw new CompanyOperationsError(
        "company bundle contains a service agent for a missing department",
      );
    }
    return parsed;
  }

  async importCompany(organizationId: string, input: unknown): Promise<CompanyOperationsOverview> {
    const bundle = this.validateImport(input);
    const departmentIdMap = new Map<string, string>();
    const serviceAgentIdMap = new Map<string, string>();
    const proposalIdMap = new Map<string, string>();
    for (const department of bundle.departments) {
      departmentIdMap.set(
        department.id,
        await remapIfOwnedByAnother(
          this.db,
          departments,
          department.id,
          organizationId,
          "department",
        ),
      );
    }
    for (const agent of bundle.serviceAgents) {
      serviceAgentIdMap.set(
        agent.id,
        await remapIfOwnedByAnother(
          this.db,
          serviceAgents,
          agent.id,
          organizationId,
          "service-agent",
        ),
      );
    }
    for (const proposal of bundle.autonomyProposals) {
      proposalIdMap.set(
        proposal.id,
        await remapIfOwnedByAnother(
          this.db,
          autonomyProposals,
          proposal.id,
          organizationId,
          "autonomy-proposal",
        ),
      );
    }
    for (const department of bundle.departments) {
      const id = departmentIdMap.get(department.id) ?? department.id;
      await this.db
        .insert(departments)
        .values({ ...department, id, organizationId })
        .onConflictDoUpdate({
          target: departments.id,
          set: { ...department, id, organizationId, updatedAt: now() },
        })
        .run();
    }
    for (const member of bundle.members) {
      const departmentId = departmentIdMap.get(member.departmentId) ?? member.departmentId;
      await this.db
        .insert(departmentMembers)
        .values({ ...member, departmentId, organizationId })
        .onConflictDoUpdate({
          target: [departmentMembers.departmentId, departmentMembers.agentId],
          set: { role: member.role, updatedAt: now() },
        })
        .run();
    }
    for (const agent of bundle.serviceAgents) {
      const row = {
        id: serviceAgentIdMap.get(agent.id) ?? agent.id,
        organizationId,
        agentId: agent.agentId,
        departmentId: agent.departmentId
          ? (departmentIdMap.get(agent.departmentId) ?? agent.departmentId)
          : null,
        status: agent.status,
        heartbeatAt: agent.heartbeatAt,
        lastRunAt: agent.lastRunAt,
        failureCount: agent.failureCount,
        metadataJson: JSON.stringify(agent.metadata),
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      };
      await this.db
        .insert(serviceAgents)
        .values(row)
        .onConflictDoUpdate({ target: serviceAgents.id, set: { ...row, updatedAt: now() } })
        .run();
    }
    for (const proposal of bundle.autonomyProposals) {
      const row = {
        id: proposalIdMap.get(proposal.id) ?? proposal.id,
        organizationId,
        targetType: proposal.targetType,
        targetId: proposal.targetId,
        fromLevel: proposal.fromLevel,
        toLevel: proposal.toLevel,
        rationale: proposal.rationale,
        evidenceJson: JSON.stringify(proposal.evidence),
        status: proposal.status,
        proposedBy: proposal.proposedBy,
        reviewedBy: proposal.reviewedBy,
        reviewReason: proposal.reviewReason,
        reviewedAt: proposal.reviewedAt,
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
      };
      await this.db
        .insert(autonomyProposals)
        .values(row)
        .onConflictDoUpdate({ target: autonomyProposals.id, set: { ...row, updatedAt: now() } })
        .run();
    }
    return this.getOverview(organizationId);
  }

  private async getDepartment(organizationId: string, id: string) {
    const rows = await this.db
      .select()
      .from(departments)
      .where(and(eq(departments.id, id), eq(departments.organizationId, organizationId)))
      .limit(1);
    return rows[0] ? toDepartment(rows[0]) : null;
  }
}

export function validateAgentHierarchy(
  agents: ReadonlyArray<{ id: string; reportsTo: string | null }>,
): string[] {
  const ids = new Set(agents.map((agent) => agent.id));
  const errors: string[] = [];
  for (const agent of agents) {
    if (!agent.reportsTo) continue;
    if (!ids.has(agent.reportsTo)) errors.push(`${agent.id} reports to missing ${agent.reportsTo}`);
    const seen = new Set<string>([agent.id]);
    let current: string | null = agent.reportsTo;
    while (current) {
      if (seen.has(current)) {
        errors.push(`manager cycle includes ${current}`);
        break;
      }
      seen.add(current);
      current = agents.find((candidate) => candidate.id === current)?.reportsTo ?? null;
    }
  }
  return [...new Set(errors)];
}

const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}/${randomUUID()}`;
async function remapIfOwnedByAnother(
  db: SqliteDb,
  table: typeof departments | typeof serviceAgents | typeof autonomyProposals,
  id: string,
  organizationId: string,
  prefix: string,
): Promise<string> {
  const rows = await db.select().from(table).where(eq(table.id, id)).limit(1);
  return rows[0] && rows[0].organizationId !== organizationId ? makeId(prefix) : id;
}
const parseJson = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};
const toDepartment = (row: typeof departments.$inferSelect): Department =>
  departmentSchema.parse(row);
const toMember = (row: typeof departmentMembers.$inferSelect): DepartmentMember =>
  departmentMemberSchema.parse(row);
const toServiceAgent = (row: typeof serviceAgents.$inferSelect): ServiceAgent => {
  const { metadataJson, ...portable } = row;
  return serviceAgentSchema.parse({ ...portable, metadata: parseJson(metadataJson) });
};
const toProposal = (row: typeof autonomyProposals.$inferSelect): AutonomyProposal => {
  const { evidenceJson, ...portable } = row;
  return autonomyProposalSchema.parse({ ...portable, evidence: parseJson(evidenceJson) });
};
const toDepartmentInsert = (row: Department) => ({ ...row });
const toMemberInsert = (row: DepartmentMember) => ({ ...row });
const toServiceAgentInsert = (row: ServiceAgent) => ({
  id: row.id,
  organizationId: row.organizationId,
  agentId: row.agentId,
  departmentId: row.departmentId,
  status: row.status,
  heartbeatAt: row.heartbeatAt,
  lastRunAt: row.lastRunAt,
  failureCount: row.failureCount,
  metadataJson: JSON.stringify(row.metadata),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const toProposalInsert = (row: AutonomyProposal) => ({
  id: row.id,
  organizationId: row.organizationId,
  targetType: row.targetType,
  targetId: row.targetId,
  fromLevel: row.fromLevel,
  toLevel: row.toLevel,
  rationale: row.rationale,
  evidenceJson: JSON.stringify(row.evidence),
  status: row.status,
  proposedBy: row.proposedBy,
  reviewedBy: row.reviewedBy,
  reviewReason: row.reviewReason,
  reviewedAt: row.reviewedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
