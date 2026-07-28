import { randomUUID } from "node:crypto";
import {
  type ControlDecision,
  controlDecisionSchema,
  type ExecutionContext,
  type OperatorEscalation,
  type OperatorLease,
  type OperatorRun,
  operatorEscalationSchema,
  operatorLeaseSchema,
  operatorRunSchema,
  type ProcessDefinition,
  processDefinitionSchema,
} from "@aaspai/contracts/operator";
import {
  and,
  eq,
  executionControlDecisions,
  executionEscalations,
  executionOperatorLeases,
  executionOperatorRuns,
  executionProcessDefinitions,
  isNull,
  lte,
  type SqliteDb,
} from "@aaspai/db";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}/${randomUUID()}`;

export class OperatorStateStore {
  constructor(private readonly db: SqliteDb) {}

  async saveProcessDefinition(definition: ProcessDefinition): Promise<ProcessDefinition> {
    const { order: _order, ...definitionSnapshot } = definition as ProcessDefinition & {
      order?: readonly string[];
    };
    const parsed = processDefinitionSchema.parse(definitionSnapshot);
    const existing = await this.db
      .select()
      .from(executionProcessDefinitions)
      .where(
        and(
          eq(executionProcessDefinitions.organizationId, parsed.organizationId),
          eq(executionProcessDefinitions.id, parsed.id),
          eq(executionProcessDefinitions.revision, parsed.revision),
        ),
      )
      .limit(1);
    if (existing[0]) {
      const stored = processDefinitionSchema.parse(JSON.parse(existing[0].definitionJson));
      if (stored.contentHash !== parsed.contentHash)
        throw new Error("process definition revision is immutable");
      return stored;
    }
    await this.db.insert(executionProcessDefinitions).values({
      id: parsed.id,
      organizationId: parsed.organizationId,
      revision: parsed.revision,
      contentHash: parsed.contentHash,
      name: parsed.name,
      description: parsed.description,
      definitionJson: JSON.stringify(parsed),
      createdAt: parsed.createdAt,
    });
    return parsed;
  }

  async createOperatorRun(
    input: Omit<OperatorRun, "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): Promise<OperatorRun> {
    const timestamp = input.createdAt ?? now();
    const parsed = operatorRunSchema.parse({
      ...input,
      createdAt: timestamp,
      updatedAt: input.updatedAt ?? timestamp,
    });
    const existing = await this.db
      .select()
      .from(executionOperatorRuns)
      .where(
        and(
          eq(executionOperatorRuns.organizationId, parsed.organizationId),
          eq(executionOperatorRuns.id, parsed.id),
        ),
      )
      .limit(1);
    if (existing[0]) return operatorRunSchema.parse(existing[0]);
    await this.db.insert(executionOperatorRuns).values(parsed);
    return parsed;
  }

  async getOperatorRun(
    context: ExecutionContext,
    operatorRunId: string,
  ): Promise<OperatorRun | null> {
    const rows = await this.db
      .select()
      .from(executionOperatorRuns)
      .where(
        and(
          eq(executionOperatorRuns.organizationId, context.organizationId),
          eq(executionOperatorRuns.id, operatorRunId),
        ),
      )
      .limit(1);
    return rows[0] ? operatorRunSchema.parse(rows[0]) : null;
  }

  async updateOperatorRun(
    context: ExecutionContext,
    operatorRunId: string,
    patch: Partial<Pick<OperatorRun, "status" | "workflowRunId" | "wakeAt">>,
  ): Promise<OperatorRun> {
    await this.db
      .update(executionOperatorRuns)
      .set({ ...patch, updatedAt: now() })
      .where(
        and(
          eq(executionOperatorRuns.organizationId, context.organizationId),
          eq(executionOperatorRuns.id, operatorRunId),
        ),
      );
    const updated = await this.getOperatorRun(context, operatorRunId);
    if (!updated) throw new Error(`Operator run ${operatorRunId} not found`);
    return updated;
  }

  async acquireLease(
    context: ExecutionContext,
    operatorRunId: string,
    ttlMs = 30_000,
  ): Promise<OperatorLease | null> {
    const timestamp = Date.now();
    await this.db
      .update(executionOperatorLeases)
      .set({ releasedAt: new Date(timestamp).toISOString() })
      .where(
        and(
          eq(executionOperatorLeases.organizationId, context.organizationId),
          lte(executionOperatorLeases.expiresAt, new Date(timestamp).toISOString()),
          isNull(executionOperatorLeases.releasedAt),
        ),
      );
    const acquiredAt = new Date(timestamp).toISOString();
    const row = {
      id: id("operator-lease"),
      organizationId: context.organizationId,
      operatorRunId,
      owner: context.actorId,
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt: new Date(timestamp + ttlMs).toISOString(),
      releasedAt: null,
    };
    try {
      await this.db.insert(executionOperatorLeases).values(row);
    } catch (error) {
      if (/unique constraint failed/i.test(String(error))) return null;
      throw error;
    }
    await this.db
      .update(executionOperatorRuns)
      .set({ leaseOwner: context.actorId, leaseExpiresAt: row.expiresAt, updatedAt: acquiredAt })
      .where(
        and(
          eq(executionOperatorRuns.organizationId, context.organizationId),
          eq(executionOperatorRuns.id, operatorRunId),
        ),
      );
    return operatorLeaseSchema.parse(row);
  }

  async releaseLease(context: ExecutionContext, leaseId: string): Promise<void> {
    await this.db
      .update(executionOperatorLeases)
      .set({ releasedAt: now() })
      .where(
        and(
          eq(executionOperatorLeases.organizationId, context.organizationId),
          eq(executionOperatorLeases.id, leaseId),
          isNull(executionOperatorLeases.releasedAt),
        ),
      );
  }

  async proposeDecision(decision: ControlDecision): Promise<ControlDecision> {
    const parsed = controlDecisionSchema.parse(decision);
    try {
      await this.db.insert(executionControlDecisions).values({
        ...parsed,
        parametersJson: JSON.stringify(parsed.parameters),
      });
    } catch (error) {
      if (!/unique constraint failed/i.test(String(error))) throw error;
      const existing = await this.db
        .select()
        .from(executionControlDecisions)
        .where(
          and(
            eq(executionControlDecisions.organizationId, parsed.organizationId),
            eq(executionControlDecisions.idempotencyKey, parsed.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing[0]) return parseDecision(existing[0]);
      throw error;
    }
    return parsed;
  }

  async applyDecision(
    context: ExecutionContext,
    decisionId: string,
  ): Promise<ControlDecision | null> {
    const rows = await this.db
      .select()
      .from(executionControlDecisions)
      .where(
        and(
          eq(executionControlDecisions.organizationId, context.organizationId),
          eq(executionControlDecisions.id, decisionId),
        ),
      )
      .limit(1);
    const decision = rows[0] ? parseDecision(rows[0]) : null;
    if (!decision) return null;
    if (decision.status === "applied") return decision;
    const changed = await this.db
      .update(executionOperatorRuns)
      .set({
        observedStateVersion: decision.observedStateVersion + 1,
        latestDecisionId: decision.id,
        updatedAt: now(),
      })
      .where(
        and(
          eq(executionOperatorRuns.organizationId, context.organizationId),
          eq(executionOperatorRuns.id, decision.operatorRunId),
          eq(executionOperatorRuns.observedStateVersion, decision.observedStateVersion),
        ),
      )
      .returning({ id: executionOperatorRuns.id });
    if (changed.length !== 1) throw new Error("stale operator decision");
    const appliedAt = now();
    await this.db
      .update(executionControlDecisions)
      .set({ status: "applied", appliedAt })
      .where(
        and(
          eq(executionControlDecisions.organizationId, context.organizationId),
          eq(executionControlDecisions.id, decision.id),
          eq(executionControlDecisions.status, "proposed"),
        ),
      );
    return { ...decision, status: "applied", appliedAt };
  }

  async createEscalation(
    input: Omit<OperatorEscalation, "createdAt"> & { createdAt?: string },
  ): Promise<OperatorEscalation> {
    const parsed = operatorEscalationSchema.parse({
      ...input,
      createdAt: input.createdAt ?? now(),
    });
    await this.db
      .insert(executionEscalations)
      .values({ ...parsed, evidenceIdsJson: JSON.stringify(parsed.evidenceIds) });
    return parsed;
  }
}

function parseDecision(row: typeof executionControlDecisions.$inferSelect): ControlDecision {
  const { parametersJson, ...fields } = row;
  return controlDecisionSchema.parse({
    ...fields,
    parameters: JSON.parse(parametersJson),
  });
}
