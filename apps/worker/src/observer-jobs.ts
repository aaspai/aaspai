import { getDefaultDb } from "@aaspai/db";
import { getLogger } from "@aaspai/observability";
import {
  backfillFromControlPlane,
  defaultLiveHub,
  nowIso,
  TelemetryRepository,
  TelemetryWatcher,
} from "@aaspai/telemetry";

/**
 * Worker observer jobs: backfill, file watching, and retention.
 *
 * These are idempotent and resumable. The observer is a read-side
 * projection: observer failures never affect execution truth.
 */

const log = getLogger("worker.observer");

export interface ObserverJobs {
  stop(): Promise<void>;
  health(): { backfilled: boolean; watcherRunning: boolean; lastRetentionAt: string | null };
}

export async function startObserverJobs(organizationId: string): Promise<ObserverJobs> {
  const repo = new TelemetryRepository(getDefaultDb());
  const health = {
    backfilled: false,
    watcherRunning: false,
    lastRetentionAt: null as string | null,
  };
  let watcher: TelemetryWatcher | null = null;
  let retentionTimer: NodeJS.Timeout | null = null;

  // 1. Idempotent backfill of control-plane records into the observer.
  try {
    const result = backfillFromControlPlane(repo, { organizationId });
    health.backfilled = true;
    log.info("observer backfill complete", {
      candidates: result.candidates,
      insertedLogs: result.insertedLogs,
      sessions: result.sessions,
    });
  } catch (err) {
    log.error("observer backfill failed", { err: String(err) });
  }

  // 2. File watcher (opt-in via AASPAI_OBSERVER_WATCH=1).
  if (process.env.AASPAI_OBSERVER_WATCH === "1") {
    try {
      watcher = new TelemetryWatcher(repo, defaultLiveHub, {
        organizationId,
        backfill: process.env.AASPAI_OBSERVER_WATCH_BACKFILL === "1",
        envPaths: {
          claude: process.env.AI_OBSERVER_CLAUDE_PATH,
          codex: process.env.AI_OBSERVER_CODEX_PATH,
          gemini: process.env.AI_OBSERVER_GEMINI_PATH,
        },
      });
      await watcher.start();
      health.watcherRunning = true;
      log.info("observer watcher started");
    } catch (err) {
      log.error("observer watcher failed to start", { err: String(err) });
    }
  }

  // 3. Retention job (AASPAI_OBSERVER_RETENTION_DAYS, e.g. "90").
  const retentionDays = Number(process.env.AASPAI_OBSERVER_RETENTION_DAYS ?? 0);
  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    const runRetention = () => {
      try {
        const olderThan = nowIso();
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const result = repo.retention({ organizationId, olderThan: cutoff });
        health.lastRetentionAt = olderThan;
        log.info("observer retention complete", { result });
      } catch (err) {
        log.error("observer retention failed", { err: String(err) });
      }
    };
    retentionTimer = setInterval(runRetention, 24 * 60 * 60 * 1000);
    retentionTimer.unref?.();
    runRetention();
  }

  return {
    async stop() {
      if (retentionTimer) clearInterval(retentionTimer);
      retentionTimer = null;
      if (watcher) {
        await watcher.stop();
        watcher = null;
      }
    },
    health: () => ({ ...health }),
  };
}
