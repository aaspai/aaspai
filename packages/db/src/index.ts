// Transitional read-repository operators. Consumers must import these from
// @aaspai/db so Drizzle remains owned by the persistence package rather than
// leaking as a direct dependency into process applications.
export { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
export { type AuditAction, type AuditEventInput, audit, auditAsync } from "./audit-log";
export type { Database } from "./client";
export { closeDatabase, db, pingDatabase } from "./client";
export * as schema from "./schema";
export type { API_SCOPE_VALUES, ApiScope } from "./schema/api-keys";

// Phase 2 schema re-exports (tables + row types) so consumers don't have
// to know the schema/phase2 subpath.
export {
  loops,
  wakeups,
  sessions,
  sessionEvents,
  budgetLedger,
  auditEvents,
  type LoopRow,
  type LoopInsert,
  type WakeupRow,
  type WakeupInsert,
  type SessionRow,
  type SessionInsert,
  type SessionEventRow,
  type SessionEventInsert,
  type BudgetLedgerRow,
  type BudgetLedgerInsert,
  type AuditEventRow,
  type AuditEventInsert,
} from "./schema/phase2";

// Phase 2: dual-dialect connection (SQLite or Postgres)
export {
  createDb,
  detectBackend,
  getDefaultDb,
  closeDefaultDb,
  type DbBackend,
  type DbHandle,
  type SqliteDb,
} from "./connection";
