// Transitional read-repository operators. Consumers must import these from
// @aaspai/db so Drizzle remains owned by the persistence package rather than
// leaking as a direct dependency into process applications.
export { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
export { type AuditAction, type AuditEventInput, audit, auditAsync } from "./audit-log";
export type { Database } from "./client";
export { closeDatabase, db, pingDatabase } from "./client";
// Phase 2: dual-dialect connection (SQLite or Postgres)
export {
  closeDefaultDb,
  createDb,
  type DbBackend,
  type DbHandle,
  detectBackend,
  getDefaultDb,
  type SqliteDb,
} from "./connection";
export { runMigrations } from "./migrations.js";
export * as schema from "./schema";
export type { API_SCOPE_VALUES, ApiScope } from "./schema/api-keys";
export * from "./schema/execution";
// Phase 2 schema re-exports (tables + row types) so consumers don't have
// to know the schema/phase2 subpath.
export {
  type AuditEventInsert,
  type AuditEventRow,
  auditEvents,
  type BudgetLedgerInsert,
  type BudgetLedgerRow,
  budgetLedger,
  type LoopInsert,
  type LoopRow,
  loops,
  type SessionEventInsert,
  type SessionEventRow,
  type SessionInsert,
  type SessionRow,
  sessionEvents,
  sessions,
  type WakeupInsert,
  type WakeupRow,
  wakeups,
} from "./schema/phase2";
