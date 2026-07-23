import type {
  KnowledgeChangeRequest,
  KnowledgeProposal,
  KnowledgeProposalInput,
  KnowledgeReviewInput,
  KnowledgeSignal,
  TemporalFact,
  TemporalFactInput,
} from "@aaspai/contracts/knowledge";
import {
  knowledgeChangeRequestSchema,
  knowledgeProposalInputSchema,
  knowledgeProposalSchema,
  knowledgeReviewInputSchema,
  knowledgeSignalSchema,
  temporalFactInputSchema,
  temporalFactSchema,
} from "@aaspai/contracts/knowledge";
import {
  and,
  desc,
  eq,
  getDefaultDb,
  inArray,
  knowledgeChangeRequests,
  knowledgeProposals,
  memoryRecords,
  type SqliteDb,
  temporalFacts,
} from "@aaspai/db";

export interface KnowledgeReviewResult {
  proposal: KnowledgeProposal;
  changeRequest: KnowledgeChangeRequest | null;
}

export interface KnowledgeSnapshot {
  facts: TemporalFact[];
  proposals: KnowledgeProposal[];
  changeRequests: KnowledgeChangeRequest[];
  signals: KnowledgeSignal[];
}

export class KnowledgeCurator {
  constructor(private readonly db: SqliteDb = getDefaultDb().db) {}

  async createFact(input: TemporalFactInput): Promise<TemporalFact> {
    const parsed = temporalFactInputSchema.parse(input);
    await this.assertMemoryEvidence(parsed.organizationId, parsed.sourceMemoryIds);
    if (parsed.supersedesId) {
      const previous = await this.getFact(parsed.organizationId, parsed.supersedesId);
      if (!previous) throw new Error(`Fact to supersede was not found: ${parsed.supersedesId}`);
    }
    const now = new Date().toISOString();
    const fact = temporalFactSchema.parse({
      ...parsed,
      id: parsed.id ?? makeId("fact"),
      createdAt: parsed.createdAt ?? now,
      updatedAt: parsed.updatedAt ?? now,
    });
    const row = factToRow(fact);
    if (fact.supersedesId) {
      this.db.transaction((tx) => {
        tx.update(temporalFacts)
          .set({ status: "superseded", updatedAt: now })
          .where(
            and(
              eq(temporalFacts.organizationId, fact.organizationId),
              eq(temporalFacts.id, fact.supersedesId as string),
            ),
          )
          .run();
        tx.insert(temporalFacts).values(row).run();
      });
    } else {
      await this.db.insert(temporalFacts).values(row);
    }
    return fact;
  }

  async getFact(organizationId: string, id: string): Promise<TemporalFact | null> {
    const rows = await this.db
      .select()
      .from(temporalFacts)
      .where(and(eq(temporalFacts.organizationId, organizationId), eq(temporalFacts.id, id)))
      .limit(1);
    return rows[0] ? rowToFact(rows[0]) : null;
  }

  async listFacts(organizationId: string): Promise<TemporalFact[]> {
    const rows = await this.db
      .select()
      .from(temporalFacts)
      .where(eq(temporalFacts.organizationId, organizationId))
      .orderBy(desc(temporalFacts.updatedAt));
    return rows.map(rowToFact);
  }

  async invalidateFact(organizationId: string, id: string, reason: string): Promise<TemporalFact> {
    const current = await this.getFact(organizationId, id);
    if (!current) throw new Error(`Fact not found: ${id}`);
    const now = new Date().toISOString();
    await this.db
      .update(temporalFacts)
      .set({
        status: "invalidated",
        invalidatedAt: now,
        updatedAt: now,
        metadataJson: JSON.stringify({ ...current.metadata, invalidationReason: reason }),
      })
      .where(and(eq(temporalFacts.organizationId, organizationId), eq(temporalFacts.id, id)));
    return (await this.getFact(organizationId, id)) as TemporalFact;
  }

  async createProposal(input: KnowledgeProposalInput): Promise<KnowledgeProposal> {
    const parsed = knowledgeProposalInputSchema.parse(input);
    await this.assertMemoryEvidence(parsed.organizationId, parsed.sourceMemoryIds);
    await this.assertFacts(parsed.organizationId, parsed.factIds);
    const now = new Date().toISOString();
    const proposal = knowledgeProposalSchema.parse({
      ...parsed,
      id: parsed.id ?? makeId("proposal"),
      createdAt: parsed.createdAt ?? now,
      updatedAt: parsed.updatedAt ?? now,
    });
    await this.db.insert(knowledgeProposals).values(proposalToRow(proposal));
    return proposal;
  }

  async listProposals(organizationId: string): Promise<KnowledgeProposal[]> {
    const rows = await this.db
      .select()
      .from(knowledgeProposals)
      .where(eq(knowledgeProposals.organizationId, organizationId))
      .orderBy(desc(knowledgeProposals.updatedAt));
    return rows.map(rowToProposal);
  }

  async listChangeRequests(organizationId: string): Promise<KnowledgeChangeRequest[]> {
    const rows = await this.db
      .select()
      .from(knowledgeChangeRequests)
      .where(eq(knowledgeChangeRequests.organizationId, organizationId))
      .orderBy(desc(knowledgeChangeRequests.updatedAt));
    return rows.map(rowToChangeRequest);
  }

  async reviewProposal(input: KnowledgeReviewInput): Promise<KnowledgeReviewResult> {
    const review = knowledgeReviewInputSchema.parse(input);
    const rows = await this.db
      .select()
      .from(knowledgeProposals)
      .where(
        and(
          eq(knowledgeProposals.organizationId, review.organizationId),
          eq(knowledgeProposals.id, review.proposalId),
        ),
      )
      .limit(1);
    const current = rows[0] ? rowToProposal(rows[0]) : null;
    if (!current) throw new Error(`Knowledge proposal not found: ${review.proposalId}`);
    if (!["proposed", "under_review"].includes(current.status)) {
      throw new Error(`Knowledge proposal cannot be reviewed from status ${current.status}`);
    }
    const now = new Date().toISOString();
    const status = review.action === "accept" ? "accepted" : review.action;
    const proposal = knowledgeProposalSchema.parse({
      ...current,
      status,
      reviewedBy: review.actorId,
      reviewReason: review.reason,
      reviewedAt: now,
      updatedAt: now,
    });
    let changeRequest: KnowledgeChangeRequest | null = null;
    this.db.transaction((tx) => {
      tx.update(knowledgeProposals)
        .set({
          status: proposal.status,
          reviewedBy: proposal.reviewedBy,
          reviewReason: proposal.reviewReason,
          reviewedAt: proposal.reviewedAt,
          updatedAt: proposal.updatedAt,
        })
        .where(
          and(
            eq(knowledgeProposals.organizationId, review.organizationId),
            eq(knowledgeProposals.id, review.proposalId),
          ),
        )
        .run();
      if (review.action === "accept") {
        changeRequest = knowledgeChangeRequestSchema.parse({
          id: makeId("change"),
          organizationId: proposal.organizationId,
          proposalId: proposal.id,
          targetPath: proposal.targetPath,
          baseCommitSha: null,
          content: proposal.content,
          impactSummary: proposal.impactSummary,
          status: "proposed",
          decidedBy: null,
          decisionReason: null,
          decidedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        tx.insert(knowledgeChangeRequests).values(changeRequestToRow(changeRequest)).run();
      }
    });
    return { proposal, changeRequest };
  }

  async signals(organizationId: string, staleAfterDays = 90): Promise<KnowledgeSignal[]> {
    const facts = (await this.listFacts(organizationId)).filter((fact) =>
      ["proposed", "accepted"].includes(fact.status),
    );
    const signals: KnowledgeSignal[] = [];
    const groups = new Map<string, TemporalFact[]>();
    for (const fact of facts) {
      const key = `${fact.subject}\u0000${fact.predicate}`;
      groups.set(key, [...(groups.get(key) ?? []), fact]);
    }
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const left = group[i];
          const right = group[j];
          if (
            !left ||
            !right ||
            valuesEqual(left.value, right.value) ||
            !validityOverlaps(left, right)
          )
            continue;
          signals.push(
            knowledgeSignalSchema.parse({
              kind: "contradiction",
              severity:
                left.status === "accepted" && right.status === "accepted" ? "critical" : "warning",
              organizationId,
              factIds: [left.id, right.id],
              title: `Conflicting ${left.predicate} facts for ${left.subject}`,
              detail: `Overlapping facts disagree: ${JSON.stringify(left.value)} versus ${JSON.stringify(right.value)}.`,
              detectedAt: new Date().toISOString(),
              relatedMemoryIds: [...new Set([...left.sourceMemoryIds, ...right.sourceMemoryIds])],
            }),
          );
        }
      }
    }
    const cutoff = Date.now() - staleAfterDays * 86_400_000;
    for (const fact of facts.filter((item) => item.status === "accepted")) {
      const reference = fact.lastVerifiedAt ?? fact.updatedAt;
      if (
        Date.parse(reference) >= cutoff &&
        !(fact.validTo && Date.parse(fact.validTo) < Date.now())
      )
        continue;
      signals.push(
        knowledgeSignalSchema.parse({
          kind: "staleness",
          severity: fact.validTo && Date.parse(fact.validTo) < Date.now() ? "warning" : "info",
          organizationId,
          factIds: [fact.id],
          title: `Fact may be stale: ${fact.subject} ${fact.predicate}`,
          detail:
            fact.validTo && Date.parse(fact.validTo) < Date.now()
              ? `The fact validity window ended at ${fact.validTo}.`
              : `The fact has not been verified since ${reference}.`,
          detectedAt: new Date().toISOString(),
          relatedMemoryIds: fact.sourceMemoryIds,
        }),
      );
    }
    return signals;
  }

  async snapshot(organizationId: string): Promise<KnowledgeSnapshot> {
    const [facts, proposals, changeRequests, signals] = await Promise.all([
      this.listFacts(organizationId),
      this.listProposals(organizationId),
      this.listChangeRequests(organizationId),
      this.signals(organizationId),
    ]);
    return { facts, proposals, changeRequests, signals };
  }

  private async assertMemoryEvidence(organizationId: string, ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    const rows = await this.db
      .select({ id: memoryRecords.id })
      .from(memoryRecords)
      .where(
        and(eq(memoryRecords.organizationId, organizationId), inArray(memoryRecords.id, uniqueIds)),
      );
    if (rows.length !== uniqueIds.length) {
      throw new Error(
        "Knowledge evidence must reference existing memory records in the same company",
      );
    }
  }

  private async assertFacts(organizationId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const uniqueIds = [...new Set(ids)];
    const rows = await this.db
      .select({ id: temporalFacts.id })
      .from(temporalFacts)
      .where(
        and(eq(temporalFacts.organizationId, organizationId), inArray(temporalFacts.id, uniqueIds)),
      );
    if (rows.length !== uniqueIds.length) {
      throw new Error("Knowledge proposal facts must belong to the same company");
    }
  }
}

export function createKnowledgeCurator(db?: SqliteDb): KnowledgeCurator {
  return new KnowledgeCurator(db);
}

function factToRow(fact: TemporalFact) {
  return {
    id: fact.id,
    organizationId: fact.organizationId,
    subject: fact.subject,
    predicate: fact.predicate,
    valueJson: JSON.stringify(fact.value),
    valueType: fact.valueType,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
    confidence: Math.round(fact.confidence * 1_000),
    status: fact.status,
    sourceMemoryIdsJson: JSON.stringify(fact.sourceMemoryIds),
    provenanceJson: JSON.stringify(fact.provenance),
    supersedesId: fact.supersedesId,
    invalidatedAt: fact.invalidatedAt,
    lastVerifiedAt: fact.lastVerifiedAt,
    metadataJson: JSON.stringify(fact.metadata),
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  } satisfies typeof temporalFacts.$inferInsert;
}

function rowToFact(row: typeof temporalFacts.$inferSelect): TemporalFact {
  return temporalFactSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    subject: row.subject,
    predicate: row.predicate,
    value: parseJson(row.valueJson, null),
    valueType: row.valueType,
    validFrom: row.validFrom,
    validTo: row.validTo,
    confidence: row.confidence / 1_000,
    status: row.status,
    sourceMemoryIds: parseJson(row.sourceMemoryIdsJson, []),
    provenance: parseJson(row.provenanceJson, {}),
    supersedesId: row.supersedesId,
    invalidatedAt: row.invalidatedAt,
    lastVerifiedAt: row.lastVerifiedAt,
    metadata: parseJson(row.metadataJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function proposalToRow(proposal: KnowledgeProposal) {
  return {
    id: proposal.id,
    organizationId: proposal.organizationId,
    title: proposal.title,
    summary: proposal.summary,
    content: proposal.content,
    targetPath: proposal.targetPath,
    knowledgeType: proposal.knowledgeType,
    tagsJson: JSON.stringify(proposal.tags),
    sourceMemoryIdsJson: JSON.stringify(proposal.sourceMemoryIds),
    factIdsJson: JSON.stringify(proposal.factIds),
    provenanceJson: JSON.stringify(proposal.provenance),
    impactSummary: proposal.impactSummary,
    status: proposal.status,
    reviewedBy: proposal.reviewedBy,
    reviewReason: proposal.reviewReason,
    reviewedAt: proposal.reviewedAt,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  } satisfies typeof knowledgeProposals.$inferInsert;
}

function rowToProposal(row: typeof knowledgeProposals.$inferSelect): KnowledgeProposal {
  return knowledgeProposalSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    summary: row.summary,
    content: row.content,
    targetPath: row.targetPath,
    knowledgeType: row.knowledgeType,
    tags: parseJson(row.tagsJson, []),
    sourceMemoryIds: parseJson(row.sourceMemoryIdsJson, []),
    factIds: parseJson(row.factIdsJson, []),
    provenance: parseJson(row.provenanceJson, {}),
    impactSummary: row.impactSummary,
    status: row.status,
    reviewedBy: row.reviewedBy,
    reviewReason: row.reviewReason,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function changeRequestToRow(request: KnowledgeChangeRequest) {
  return {
    id: request.id,
    organizationId: request.organizationId,
    proposalId: request.proposalId,
    targetPath: request.targetPath,
    baseCommitSha: request.baseCommitSha,
    content: request.content,
    impactSummary: request.impactSummary,
    status: request.status,
    decidedBy: request.decidedBy,
    decisionReason: request.decisionReason,
    decidedAt: request.decidedAt,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  } satisfies typeof knowledgeChangeRequests.$inferInsert;
}

function rowToChangeRequest(
  row: typeof knowledgeChangeRequests.$inferSelect,
): KnowledgeChangeRequest {
  return knowledgeChangeRequestSchema.parse(row);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validityOverlaps(left: TemporalFact, right: TemporalFact): boolean {
  const leftStart = left.validFrom ? Date.parse(left.validFrom) : Number.NEGATIVE_INFINITY;
  const rightStart = right.validFrom ? Date.parse(right.validFrom) : Number.NEGATIVE_INFINITY;
  const leftEnd = left.validTo ? Date.parse(left.validTo) : Number.POSITIVE_INFINITY;
  const rightEnd = right.validTo ? Date.parse(right.validTo) : Number.POSITIVE_INFINITY;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
