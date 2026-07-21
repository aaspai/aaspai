import type { AuditEvent, AuditQuery } from "@aaspai/contracts/audit";
import { AuditImmutabilityError } from "../errors";
import type { AuditStore } from "../port";

/**
 * In-memory append-only audit store for tests.
 * Enforces immutability — events cannot be modified after append.
 */
export class InMemoryAuditStore implements AuditStore {
  #events: AuditEvent[] = [];
  #frozen = new Set<string>();

  async append(event: AuditEvent): Promise<void> {
    if (this.#frozen.has(event.id)) {
      throw new AuditImmutabilityError(event.id);
    }
    this.#events.push(event);
    this.#frozen.add(event.id);
  }

  async appendMany(events: AuditEvent[]): Promise<void> {
    for (const event of events) {
      if (this.#frozen.has(event.id)) {
        throw new AuditImmutabilityError(event.id);
      }
    }
    for (const event of events) {
      this.#events.push(event);
      this.#frozen.add(event.id);
    }
  }

  async query(query: AuditQuery): Promise<AuditEvent[]> {
    let filtered = [...this.#events];

    if (query.organizationId) {
      filtered = filtered.filter((e) => e.organizationId === query.organizationId);
    }
    if (query.actionPrefix) {
      const prefix = query.actionPrefix;
      filtered = filtered.filter((e) => e.action.startsWith(prefix));
    }
    if (query.targetType) {
      filtered = filtered.filter((e) => e.targetType === query.targetType);
    }
    if (query.targetId) {
      filtered = filtered.filter((e) => e.targetId != null && e.targetId === query.targetId);
    }
    if (query.actorId) {
      filtered = filtered.filter((e) => e.actorId === query.actorId);
    }
    if (query.correlationId) {
      filtered = filtered.filter((e) => e.correlationId === query.correlationId);
    }
    if (query.from) {
      const from = Date.parse(query.from);
      filtered = filtered.filter((e) => Date.parse(e.occurredAt) >= from);
    }
    if (query.to) {
      const to = Date.parse(query.to);
      filtered = filtered.filter((e) => Date.parse(e.occurredAt) <= to);
    }

    if (query.order === "asc") {
      filtered.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    } else {
      filtered.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    return filtered.slice(offset, offset + limit);
  }

  async count(query: AuditQuery): Promise<number> {
    const results = await this.query({ ...query, limit: 1_000_000 });
    return results.length;
  }

  async get(id: string): Promise<AuditEvent | null> {
    return this.#events.find((e) => e.id === id) ?? null;
  }

  async prune(maxAgeDays: number, _batchSize?: number): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const before = this.#events.length;
    this.#events = this.#events.filter((e) => Date.parse(e.recordedAt) > cutoff);
    const deleted = before - this.#events.length;
    return deleted;
  }

  /** Return all stored events (for test assertions). */
  all(): AuditEvent[] {
    return [...this.#events];
  }
}
