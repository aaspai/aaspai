import type { AuditEvent, AuditQuery } from "@aaspai/contracts/audit";
import { AuditStorageError } from "../errors";
import type { AuditStore } from "../port";

/**
 * PostgreSQL adapter for the audit store.
 *
 * This adapter wraps the existing `audit_log` table in @aaspai/db.
 * It assumes the caller provides Drizzle query helpers and schema
 * references to avoid coupling the audit package to a specific ORM.
 */
export interface PostgresAuditDeps {
  insert: (
    table: unknown,
    values: unknown,
  ) => { values: (v: unknown) => { returning: () => Promise<unknown[]> } };
  select: (fields?: unknown) => {
    from: (table: unknown) => { where: (...args: unknown[]) => unknown };
  };
  eq: (a: unknown, b: unknown) => unknown;
  gte: (a: unknown, b: unknown) => unknown;
  lte: (a: unknown, b: unknown) => unknown;
  and: (...args: unknown[]) => unknown;
  like: (a: unknown, b: unknown) => unknown;
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
  count: () => unknown;
  auditLogTable: unknown;
}

/**
 * Create a PostgreSQL-backed audit store.
 *
 * Usage:
 * ```ts
 * import { db, schema } from "@aaspai/db";
 * import { eq, and, gte, lte, like, sql, count } from "drizzle-orm";
 * const store = createPostgresAuditStore({ db, schema, eq, and, gte, lte, like, sql, count });
 * ```
 */
export function createPostgresAuditStore(deps: {
  db: {
    insert: (table: unknown) => { values: (v: unknown) => { returning: () => Promise<unknown[]> } };
    select: (fields?: unknown) => {
      from: (table: unknown) => {
        where: (...args: unknown[]) => unknown;
        orderBy: (...args: unknown[]) => unknown;
        limit: (n: number) => unknown;
        offset: (n: number) => unknown;
      };
    };
    delete: (table: unknown) => { where: (...args: unknown[]) => Promise<unknown> };
    execute: (query: unknown) => Promise<unknown>;
  };
  auditLog: unknown;
  eq: (a: unknown, b: unknown) => unknown;
  and: (...args: unknown[]) => unknown;
  gte: (a: unknown, b: unknown) => unknown;
  lte: (a: unknown, b: unknown) => unknown;
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
}): AuditStore {
  return {
    async append(event: AuditEvent): Promise<void> {
      try {
        await deps.db.insert(deps.auditLog).values(event as never);
      } catch (err) {
        throw new AuditStorageError(
          err instanceof Error ? err.message : "Failed to append audit event",
        );
      }
    },

    async appendMany(events: AuditEvent[]): Promise<void> {
      try {
        for (const event of events) {
          await deps.db.insert(deps.auditLog).values(event as never);
        }
      } catch (err) {
        throw new AuditStorageError(
          err instanceof Error ? err.message : "Failed to append audit events",
        );
      }
    },

    async query(query: AuditQuery): Promise<AuditEvent[]> {
      const conditions: unknown[] = [];
      if (query.organizationId) {
        conditions.push(
          deps.eq((deps.auditLog as Record<string, unknown>).organizationId, query.organizationId),
        );
      }
      if (query.actorId) {
        conditions.push(deps.eq((deps.auditLog as Record<string, unknown>).actorId, query.actorId));
      }
      if (query.targetType) {
        conditions.push(
          deps.eq((deps.auditLog as Record<string, unknown>).targetType, query.targetType),
        );
      }
      if (query.targetId) {
        conditions.push(
          deps.eq((deps.auditLog as Record<string, unknown>).targetId, query.targetId),
        );
      }
      if (query.from) {
        conditions.push(
          deps.gte((deps.auditLog as Record<string, unknown>).occurredAt, query.from),
        );
      }
      if (query.to) {
        conditions.push(deps.lte((deps.auditLog as Record<string, unknown>).occurredAt, query.to));
      }

      const where = conditions.length > 0 ? deps.and(...conditions) : undefined;

      const rows = await (deps.db.select().from(deps.auditLog).where(where) as unknown as Promise<
        Record<string, unknown>[]
      >);

      return (rows ?? []) as unknown as AuditEvent[];
    },

    async count(query: AuditQuery): Promise<number> {
      const rows = await this.query(query);
      return rows.length;
    },

    async get(id: string): Promise<AuditEvent | null> {
      const rows = await (deps.db
        .select()
        .from(deps.auditLog)
        .where(deps.eq((deps.auditLog as Record<string, unknown>).id, id)) as unknown as Promise<
        Record<string, unknown>[]
      >);
      return (rows?.[0] as AuditEvent | undefined) ?? null;
    },

    async prune(maxAgeDays: number, _batchSize?: number): Promise<number> {
      const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      const result = await deps.db.execute(
        deps.sql`DELETE FROM audit_log WHERE recorded_at < ${cutoff}`,
      );
      return (result as { rowCount?: number }).rowCount ?? 0;
    },
  };
}
