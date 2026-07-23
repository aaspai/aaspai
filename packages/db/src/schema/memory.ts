import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const memoryRecords = sqliteTable(
  "memory_records",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    scopeJson: text("scope_json").notNull(),
    sensitivity: text("sensitivity").notNull().default("internal"),
    provenanceJson: text("provenance_json").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    retentionJson: text("retention_json").notNull().default("{}"),
    status: text("status").notNull().default("active"),
    tagsJson: text("tags_json").notNull().default("[]"),
    relatedIdsJson: text("related_ids_json").notNull().default("[]"),
    supersedesId: text("supersedes_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    expiresAt: text("expires_at"),
    tokenCount: integer("token_count").notNull().default(0),
  },
  (t) => ({
    organizationStatusIdx: index("memory_records_org_status_idx").on(t.organizationId, t.status),
    scopeIdx: index("memory_records_scope_idx").on(t.organizationId, t.createdAt),
    sourceHashIdx: index("memory_records_source_hash_idx").on(t.organizationId, t.contentHash),
  }),
);

export type MemoryRecordRow = typeof memoryRecords.$inferSelect;
export type MemoryRecordInsert = typeof memoryRecords.$inferInsert;
