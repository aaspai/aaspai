import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const temporalFacts = sqliteTable(
  "temporal_facts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    subject: text("subject").notNull(),
    predicate: text("predicate").notNull(),
    valueJson: text("value_json").notNull(),
    valueType: text("value_type").notNull(),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    confidence: integer("confidence").notNull().default(500),
    status: text("status").notNull().default("proposed"),
    sourceMemoryIdsJson: text("source_memory_ids_json").notNull(),
    provenanceJson: text("provenance_json").notNull(),
    supersedesId: text("supersedes_id"),
    invalidatedAt: text("invalidated_at"),
    lastVerifiedAt: text("last_verified_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgSubjectPredicateIdx: index("temporal_facts_org_subject_predicate_idx").on(
      t.organizationId,
      t.subject,
      t.predicate,
    ),
    orgStatusIdx: index("temporal_facts_org_status_idx").on(t.organizationId, t.status),
    supersedesIdx: index("temporal_facts_supersedes_idx").on(t.supersedesId),
  }),
);

export const knowledgeProposals = sqliteTable(
  "knowledge_proposals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    content: text("content").notNull(),
    targetPath: text("target_path").notNull(),
    knowledgeType: text("knowledge_type").notNull(),
    tagsJson: text("tags_json").notNull().default("[]"),
    sourceMemoryIdsJson: text("source_memory_ids_json").notNull(),
    factIdsJson: text("fact_ids_json").notNull().default("[]"),
    provenanceJson: text("provenance_json").notNull(),
    impactSummary: text("impact_summary").notNull(),
    status: text("status").notNull().default("proposed"),
    reviewedBy: text("reviewed_by"),
    reviewReason: text("review_reason"),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgStatusIdx: index("knowledge_proposals_org_status_idx").on(t.organizationId, t.status),
    targetPathIdx: index("knowledge_proposals_target_path_idx").on(t.organizationId, t.targetPath),
  }),
);

export const knowledgeChangeRequests = sqliteTable(
  "knowledge_change_requests",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    targetPath: text("target_path").notNull(),
    baseCommitSha: text("base_commit_sha"),
    content: text("content").notNull(),
    impactSummary: text("impact_summary").notNull(),
    status: text("status").notNull().default("proposed"),
    decidedBy: text("decided_by"),
    decisionReason: text("decision_reason"),
    decidedAt: text("decided_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    proposalUniq: uniqueIndex("knowledge_change_requests_proposal_uniq").on(t.proposalId),
    orgStatusIdx: index("knowledge_change_requests_org_status_idx").on(t.organizationId, t.status),
  }),
);

export type TemporalFactRow = typeof temporalFacts.$inferSelect;
export type TemporalFactInsert = typeof temporalFacts.$inferInsert;
export type KnowledgeProposalRow = typeof knowledgeProposals.$inferSelect;
export type KnowledgeProposalInsert = typeof knowledgeProposals.$inferInsert;
export type KnowledgeChangeRequestRow = typeof knowledgeChangeRequests.$inferSelect;
export type KnowledgeChangeRequestInsert = typeof knowledgeChangeRequests.$inferInsert;
