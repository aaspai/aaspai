import type { RuntimeProgressPhase, RuntimeProgressUpdate } from "@aaspai/contracts/runtime";

/**
 * Throttled runtime progress reporter.
 *
 * Emits a `RuntimeProgressUpdate` to the supplied sink at most every
 * `minIntervalMs` (default 2 s) OR whenever the percentage step changes
 * by at least `minStepPercent` (default 10). Designed to keep the
 * progress channel quiet for large transfers while still feeling
 * responsive.
 */
export type RuntimeProgressSink = (update: RuntimeProgressUpdate) => Promise<void> | void;

export interface CreateRuntimeProgressReporterOptions {
  sink: RuntimeProgressSink;
  minIntervalMs?: number;
  minStepPercent?: number;
}

export interface RuntimeProgressReporter {
  report(update: Omit<RuntimeProgressUpdate, "percent"> & { percent?: number }): void;
  flush(): Promise<void>;
}

const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_MIN_STEP_PERCENT = 10;

export function createRuntimeProgressReporter(
  options: CreateRuntimeProgressReporterOptions,
): RuntimeProgressReporter {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const minStepPercent = options.minStepPercent ?? DEFAULT_MIN_STEP_PERCENT;
  const sink = options.sink;

  let lastSentAt = 0;
  let lastSentPercent = -1;
  let pending: RuntimeProgressUpdate | null = null;
  let flushTimer: NodeJS.Timeout | undefined;

  const computePercent = (u: { transferredBytes: number; totalBytes?: number }): number => {
    if (u.totalBytes === undefined || u.totalBytes === 0) return 0;
    return Math.min(100, Math.max(0, Math.round((u.transferredBytes / u.totalBytes) * 100)));
  };

  const emit = async (update: RuntimeProgressUpdate): Promise<void> => {
    try {
      await sink(update);
    } catch {
      // sink errors must not break the run
    }
  };

  return {
    report(raw) {
      const percent = raw.percent ?? computePercent(raw);
      const update: RuntimeProgressUpdate = { ...raw, percent };
      const now = Date.now();
      const elapsed = now - lastSentAt;
      const stepDelta = Math.abs(percent - lastSentPercent);
      if (elapsed >= minIntervalMs || stepDelta >= minStepPercent || percent >= 100) {
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        pending = null;
        lastSentAt = now;
        lastSentPercent = percent;
        void emit(update);
        return;
      }
      pending = update;
      if (flushTimer === undefined) {
        flushTimer = setTimeout(
          () => {
            flushTimer = undefined;
            if (pending) {
              const p = pending;
              pending = null;
              lastSentAt = Date.now();
              lastSentPercent = p.percent ?? 0;
              void emit(p);
            }
          },
          Math.max(0, minIntervalMs - elapsed),
        );
        flushTimer.unref();
      }
    },
    async flush() {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (pending) {
        const p = pending;
        pending = null;
        lastSentAt = Date.now();
        lastSentPercent = p.percent ?? 0;
        await emit(p);
      }
    },
  };
}

export const RUNTIME_PROGRESS_PHASES: Readonly<Record<RuntimeProgressPhase, true>> = Object.freeze({
  git_sync: true,
  config_sync: true,
  adapter_startup: true,
  restore: true,
  export: true,
  finalize: true,
  upload: true,
  download: true,
});
