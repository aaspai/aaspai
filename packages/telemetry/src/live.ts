import { nowIso } from "./canonical.js";

/**
 * In-memory live event hub (SSE fanout).
 *
 * Mirrors the reference WebSocket hub but uses bounded per-client
 * buffers: a slow client is dropped rather than blocking ingestion
 * (plan §9.2, OBS-T211). The hub does not persist events; persistence
 * is the repository's job.
 */

export interface LiveEnvelope {
  id: string;
  organizationId: string;
  type: "log" | "span" | "metric" | "session" | "ingest_error" | "import";
  ts: string;
  event: Record<string, unknown>;
}

export interface LiveSubscription {
  organizationId: string;
  /** Buffer of pending events for this subscriber. */
  queue: LiveEnvelope[];
  /** True while the subscriber is connected and consuming. */
  active: boolean;
  lastEventId: string | null;
}

const MAX_QUEUE = 1_024;

export class LiveHub {
  private readonly subscribers = new Map<string, Set<LiveSubscription>>();
  private seq = 0;

  subscribe(organizationId: string, lastEventId?: string | null): LiveSubscription {
    const sub: LiveSubscription = {
      organizationId,
      queue: [],
      active: true,
      lastEventId: lastEventId ?? null,
    };
    let set = this.subscribers.get(organizationId);
    if (!set) {
      set = new Set();
      this.subscribers.set(organizationId, set);
    }
    set.add(sub);
    return sub;
  }

  unsubscribe(sub: LiveSubscription): void {
    sub.active = false;
    const set = this.subscribers.get(sub.organizationId);
    if (set) set.delete(sub);
  }

  /** Enqueue an event for every subscriber of the org. Never blocks. */
  publish(input: {
    organizationId: string;
    type: LiveEnvelope["type"];
    event: Record<string, unknown>;
  }): LiveEnvelope {
    this.seq += 1;
    const envelope: LiveEnvelope = {
      id: `live_${this.seq}_${input.organizationId.slice(0, 6)}`,
      organizationId: input.organizationId,
      type: input.type,
      ts: nowIso(),
      event: input.event,
    };
    const set = this.subscribers.get(input.organizationId);
    if (!set) return envelope;
    for (const sub of set) {
      if (!sub.active) continue;
      if (sub.queue.length >= MAX_QUEUE) {
        sub.active = false;
        set.delete(sub);
        continue;
      }
      sub.queue.push(envelope);
      sub.lastEventId = envelope.id;
    }
    return envelope;
  }

  /** Drain available events (SSE tick loop). Returns and clears the queue. */
  drain(sub: LiveSubscription): LiveEnvelope[] {
    if (sub.queue.length === 0) return [];
    const events = sub.queue;
    sub.queue = [];
    return events;
  }

  subscriberCount(organizationId: string): number {
    return this.subscribers.get(organizationId)?.size ?? 0;
  }
}

/** Global singleton shared by the API routes. */
export const defaultLiveHub = new LiveHub();
