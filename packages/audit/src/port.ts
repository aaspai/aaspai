import type { AuditEvent, AuditQuery } from "@aaspai/contracts/audit";

/**
 * Immutable append-only audit store.
 *
 * Once an event is appended it must never be modified or deleted
 * (enforced at the adapter level via DB triggers or in-memory
 * guards).
 */
export interface AuditStore {
  /** Append an audit event to the store. */
  append(event: AuditEvent): Promise<void>;

  /** Append multiple audit events atomically. */
  appendMany(events: AuditEvent[]): Promise<void>;

  /** Query audit events with filters and pagination. */
  query(query: AuditQuery): Promise<AuditEvent[]>;

  /** Count audit events matching a query. */
  count(query: AuditQuery): Promise<number>;

  /** Get a single event by ID. */
  get(id: string): Promise<AuditEvent | null>;

  /**
   * Prune events older than the given age. Returns the number
   * of events deleted. Only enabled when the store supports
   * retention.
   */
  prune(maxAgeDays: number, batchSize?: number): Promise<number>;
}
