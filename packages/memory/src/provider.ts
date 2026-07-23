import { createHash, randomUUID } from "node:crypto";
import type {
  MemoryRecord,
  MemoryRecordInput,
  MemoryScope,
  MemorySearchFilters,
  MemorySearchQuery,
} from "@aaspai/contracts";
import {
  memoryRecordInputSchema,
  memoryRecordSchema,
  memorySearchQuerySchema,
} from "@aaspai/contracts/memory";
import { and, eq, getDefaultDb, memoryRecords, type SqliteDb } from "@aaspai/db";

export interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
  matchedTerms: string[];
}

export interface MemoryCheckpointRecordInput extends MemoryRecordInput {
  phase: string;
  sourceType?: "session" | "attempt" | "workflow";
  sourceId?: string;
  sessionId?: string | null;
  attemptId?: string | null;
}

export interface MemoryHealth {
  status: "ok" | "degraded";
  canonicalRecords: number;
  indexedRecords: number;
  indexLoaded: boolean;
  message: string | null;
}

export interface MemoryProvider {
  ingest(input: MemoryRecordInput): Promise<MemoryRecord>;
  get(organizationId: string, id: string): Promise<MemoryRecord | null>;
  search(input: MemorySearchQuery): Promise<MemorySearchResult[]>;
  checkpoint(input: MemoryCheckpointRecordInput): Promise<MemoryRecord>;
  health(organizationId: string): Promise<MemoryHealth>;
  rebuild(organizationId: string): Promise<{ indexedRecords: number }>;
}

export class LocalMemoryProvider implements MemoryProvider {
  private readonly index = new Map<string, Set<string>>();
  private readonly indexedRecordIds = new Map<string, Set<string>>();
  private indexedOrganizations = new Set<string>();

  constructor(private readonly db: SqliteDb = getDefaultDb().db) {}

  async ingest(input: MemoryRecordInput): Promise<MemoryRecord> {
    const parsed = memoryRecordInputSchema.parse(input);
    const now = new Date().toISOString();
    const record = memoryRecordSchema.parse({
      ...parsed,
      id: parsed.id ?? makeId("memory"),
      contentHash: sha256(
        JSON.stringify({
          kind: parsed.kind,
          title: parsed.title,
          content: parsed.content,
          scope: parsed.scope,
        }),
      ),
      createdAt: parsed.createdAt ?? now,
      updatedAt: parsed.updatedAt ?? now,
    });
    if (record.scope.organizationId !== record.organizationId) {
      throw new Error("Memory scope organizationId must match record organizationId");
    }
    const existing = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.organizationId, record.organizationId),
          eq(memoryRecords.contentHash, record.contentHash),
        ),
      )
      .limit(1);
    if (existing[0]) {
      const canonical = rowToRecord(existing[0]);
      this.indexRecord(canonical);
      return canonical;
    }
    await this.db.insert(memoryRecords).values(recordToRow(record));
    this.indexRecord(record);
    return record;
  }

  async get(organizationId: string, id: string): Promise<MemoryRecord | null> {
    const rows = await this.db
      .select()
      .from(memoryRecords)
      .where(and(eq(memoryRecords.organizationId, organizationId), eq(memoryRecords.id, id)))
      .limit(1);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async search(input: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const query = memorySearchQuerySchema.parse(input);
    const rows = await this.db
      .select()
      .from(memoryRecords)
      .where(eq(memoryRecords.organizationId, query.organizationId));
    const now = Date.now();
    const results: MemorySearchResult[] = [];
    const tokens = tokenize(query.query);
    for (const row of rows) {
      const record = rowToRecord(row);
      if (!query.filters.includeInactive && record.status !== "active") continue;
      if (record.retention.expiresAt && Date.parse(record.retention.expiresAt) <= now) continue;
      if (!scopeMatches(record.scope, query.scope)) continue;
      if (!filtersMatch(record, query.filters)) continue;
      const matchedTerms = tokens.filter((token) => searchableText(record).includes(token));
      if (tokens.length > 0 && matchedTerms.length === 0) continue;
      const score = scoreRecord(record, tokens, query.deep);
      results.push({ record, score, matchedTerms });
      this.indexRecord(record);
    }
    return results
      .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt))
      .slice(0, query.limit);
  }

  async checkpoint(input: MemoryCheckpointRecordInput): Promise<MemoryRecord> {
    const {
      phase,
      sourceType: _sourceType,
      sourceId: _sourceId,
      sessionId: _sessionId,
      attemptId: _attemptId,
      ...recordInput
    } = input;
    return this.ingest({
      ...recordInput,
      kind: input.kind ?? "checkpoint",
      metadata: { ...(input.metadata ?? {}), checkpointPhase: input.phase },
    });
  }

  async health(organizationId: string): Promise<MemoryHealth> {
    try {
      const rows = await this.db
        .select({ id: memoryRecords.id })
        .from(memoryRecords)
        .where(eq(memoryRecords.organizationId, organizationId));
      return {
        status: "ok",
        canonicalRecords: rows.length,
        indexedRecords: this.indexedRecordIds.get(organizationId)?.size ?? 0,
        indexLoaded: this.indexedOrganizations.has(organizationId),
        message: null,
      };
    } catch (error) {
      return {
        status: "degraded",
        canonicalRecords: 0,
        indexedRecords: 0,
        indexLoaded: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async rebuild(organizationId: string): Promise<{ indexedRecords: number }> {
    for (const [id, organizations] of this.index) {
      if (organizations.has(organizationId)) {
        organizations.delete(organizationId);
        if (organizations.size === 0) this.index.delete(id);
      }
    }
    this.indexedRecordIds.delete(organizationId);
    const rows = await this.db
      .select()
      .from(memoryRecords)
      .where(eq(memoryRecords.organizationId, organizationId));
    for (const row of rows) this.indexRecord(rowToRecord(row));
    this.indexedOrganizations.add(organizationId);
    return { indexedRecords: rows.length };
  }

  private indexRecord(record: MemoryRecord): void {
    const ids = this.indexedRecordIds.get(record.organizationId) ?? new Set<string>();
    ids.add(record.id);
    this.indexedRecordIds.set(record.organizationId, ids);
    for (const token of tokenize(searchableText(record))) {
      const organizations = this.index.get(token) ?? new Set<string>();
      organizations.add(record.organizationId);
      this.index.set(token, organizations);
    }
    this.indexedOrganizations.add(record.organizationId);
  }
}

export function createLocalMemoryProvider(db?: SqliteDb): LocalMemoryProvider {
  return new LocalMemoryProvider(db);
}

function recordToRow(record: MemoryRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    kind: record.kind,
    title: record.title,
    content: record.content,
    contentHash: record.contentHash,
    scopeJson: JSON.stringify(record.scope),
    sensitivity: record.sensitivity,
    provenanceJson: JSON.stringify(record.provenance),
    evidenceJson: JSON.stringify(record.evidence),
    retentionJson: JSON.stringify(record.retention),
    status: record.status,
    tagsJson: JSON.stringify(record.tags),
    relatedIdsJson: JSON.stringify(record.relatedIds),
    supersedesId: record.supersedesId,
    metadataJson: JSON.stringify(record.metadata),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.retention.expiresAt,
    tokenCount: Math.ceil(record.content.length / 4),
  } satisfies typeof memoryRecords.$inferInsert;
}

function rowToRecord(row: typeof memoryRecords.$inferSelect): MemoryRecord {
  return memoryRecordSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    title: row.title,
    content: row.content,
    contentHash: row.contentHash,
    scope: parseJson(row.scopeJson, {}),
    sensitivity: row.sensitivity,
    provenance: parseJson(row.provenanceJson, {}),
    evidence: parseJson(row.evidenceJson, []),
    retention: parseJson(row.retentionJson, {}),
    status: row.status,
    tags: parseJson(row.tagsJson, []),
    relatedIds: parseJson(row.relatedIdsJson, []),
    supersedesId: row.supersedesId,
    metadata: parseJson(row.metadataJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function scopeMatches(record: MemoryScope, requested: Partial<MemoryScope>): boolean {
  for (const key of ["projectId", "goalId", "workItemId", "agentId", "topic"] as const) {
    const value = requested[key];
    if (value != null && record[key] !== value) return false;
  }
  return record.organizationId === requested.organizationId;
}

function filtersMatch(record: MemoryRecord, filters: MemorySearchFilters): boolean {
  if (filters.kinds.length > 0 && !filters.kinds.includes(record.kind)) return false;
  if (filters.sensitivity.length > 0 && !filters.sensitivity.includes(record.sensitivity))
    return false;
  if (filters.tags.length > 0 && !filters.tags.every((tag) => record.tags.includes(tag)))
    return false;
  return true;
}

function searchableText(record: MemoryRecord): string {
  return `${record.title} ${record.content} ${record.tags.join(" ")} ${record.scope.topic ?? ""}`.toLowerCase();
}

function scoreRecord(record: MemoryRecord, tokens: string[], deep: boolean): number {
  if (tokens.length === 0) return deep ? 0.1 : 0;
  const text = searchableText(record);
  const title = record.title.toLowerCase();
  const matched = tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
  const titleBoost = tokens.reduce((score, token) => score + (title.includes(token) ? 1 : 0), 0);
  const recency = Math.max(0, 1 - (Date.now() - Date.parse(record.createdAt)) / 86_400_000 / 365);
  return matched / tokens.length + titleBoost * 0.25 + recency * 0.05;
}

function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_/-]+/)
        .filter((token) => token.length >= 3),
    ),
  ];
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
