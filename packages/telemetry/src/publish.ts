import { nowIso } from "./canonical.js";
import type { LiveHub } from "./live.js";
import type { TelemetryRepository } from "./repository.js";

/**
 * Unified live-event publish.
 *
 * Every producer (OTLP ingest, importers, watcher, native bridge,
 * deletion) publishes through this helper so that:
 *
 *  - the event is persisted with a monotonic id (`telemetry_live_events`);
 *  - the in-memory hub fans it out to connected SSE clients;
 *  - a reconnecting client can replay missed events from `last-event-id`
 *    (plan §9.2, OBS-T209/212).
 *
 * Persistence is best-effort: a live-event failure never fails the
 * underlying ingest.
 */

export function publishLive(
  repo: TelemetryRepository,
  hub: LiveHub,
  organizationId: string,
  type: "log" | "span" | "metric" | "session" | "ingest_error" | "import",
  event: Record<string, unknown>,
): void {
  let liveId = 0;
  try {
    liveId = repo.appendLiveEvent(organizationId, type, event);
  } catch {
    /* best-effort persistence */
  }
  hub.publish({
    organizationId,
    type,
    event: liveId > 0 ? { ...event, liveEventId: liveId } : event,
  });
}

export { nowIso };
