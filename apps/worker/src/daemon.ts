/**
 * Worker daemon — the long-lived process that actually runs the loop.
 *
 * Responsibilities (minimal):
 *   1. Watch the file system (agents/, knowledge/, loops/) → fresh config cache
 *   2. Tick the scheduler every `tickIntervalMs` → enqueue wakeups for due loops
 *   3. Poll queued wakeups → run the session via `@aaspai/sessions`
 *   4. Loop forever (until SIGINT/SIGTERM)
 *
 * What's NOT here (deferred):
 *   - Multi-replica leader election
 *   - Cross-process pub/sub for events
 *   - HTTP /healthz (Phase 4)
 *   - Webhooks
 *   - Job queue (Phase 4 — for now we use the wakeups table directly)
 */
import { randomUUID } from "node:crypto";
import type { LoopPattern } from "@aaspai/contracts/phase2";
import { closeDefaultDb, getDefaultDb, wakeups as wakeupsTable } from "@aaspai/db";
import {
  FileAgentConfigSource,
  FileKnowledgeSource,
  FileLoopConfigSource,
} from "@aaspai/file-loader";
import { KillSwitch, PatternRegistry, Scheduler, STARTER_PATTERNS } from "@aaspai/loops";
import { getLogger } from "@aaspai/observability";
import { Sessions } from "@aaspai/sessions";
import { and, eq } from "drizzle-orm";

const log = getLogger("worker.daemon");

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_WAKEUP_POLL_INTERVAL_MS = 5_000;

export interface DaemonOptions {
  tickIntervalMs?: number;
  wakeupPollIntervalMs?: number;
  organizationId?: string;
}

export class WorkerDaemon {
  private readonly tickIntervalMs: number;
  private readonly wakeupPollIntervalMs: number;
  private readonly organizationId: string;

  private readonly agentSource: FileAgentConfigSource;
  private readonly knowledgeSource: FileKnowledgeSource;
  private readonly loopSource: FileLoopConfigSource;
  private readonly sessions: Sessions;
  private readonly scheduler: Scheduler;
  private readonly killSwitch: KillSwitch;
  private readonly patternRegistry: PatternRegistry;

  private tickHandle: NodeJS.Timeout | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private inFlightSession: Promise<void> | null = null;
  private shuttingDown = false;
  private running = false;
  private startedAt: string | null = null;

  constructor(opts: DaemonOptions = {}) {
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.wakeupPollIntervalMs = opts.wakeupPollIntervalMs ?? DEFAULT_WAKEUP_POLL_INTERVAL_MS;
    this.organizationId = opts.organizationId ?? "default";

    this.agentSource = new FileAgentConfigSource(process.env.AASPAI_AGENTS_DIR ?? "./agents");
    this.knowledgeSource = new FileKnowledgeSource(
      process.env.AASPAI_KNOWLEDGE_DIR ?? "./knowledge",
    );
    this.loopSource = new FileLoopConfigSource(process.env.AASPAI_LOOPS_DIR ?? "./loops");
    this.sessions = new Sessions({
      agentSource: this.agentSource,
      knowledgeSource: this.knowledgeSource,
      skillRegistry: undefined as never, // foundation: skills are no-op
    });

    this.killSwitch = new KillSwitch();
    this.patternRegistry = new PatternRegistry();
    for (const p of STARTER_PATTERNS) this.patternRegistry.register(p);

    this.scheduler = new Scheduler(this.patternRegistry, this.killSwitch, {
      organizationId: this.organizationId,
      tickIntervalMs: this.tickIntervalMs,
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date().toISOString();

    log.info("worker starting", {
      tickIntervalMs: this.tickIntervalMs,
      wakeupPollIntervalMs: this.wakeupPollIntervalMs,
    });

    await this.agentSource.start();
    await this.knowledgeSource.start();
    await this.loopSource.start();
    log.info("file sources ready", {
      agents: (await this.agentSource.list()).length,
      knowledge: (await this.knowledgeSource.list()).length,
      loops: (await this.loopSource.list()).length,
    });

    this.scheduler.start();
    this.tickHandle = setInterval(() => {
      this.tickScheduler().catch((err) => log.error("scheduler tick failed", { err: String(err) }));
    }, this.tickIntervalMs);
    this.tickHandle.unref();

    this.pollHandle = setInterval(() => {
      this.pollWakeups().catch((err) => log.error("wakeup poll failed", { err: String(err) }));
    }, this.wakeupPollIntervalMs);
    this.pollHandle.unref();

    this.installShutdownHandlers();

    await this.recoverStaleClaims();

    log.info("worker started");
  }

  private installShutdownHandlers(): void {
    const handle = (signal: NodeJS.Signals) => {
      log.info("received shutdown signal", { signal });
      // stop() is async but we can't await a signal handler.
      // Mark shuttingDown immediately so pollWakeups/claimAndRun
      // bail; then call stop() which awaits the in-flight session.
      this.shuttingDown = true;
      void this.stop()
        .then(() => process.exit(0))
        .catch((err) => {
          log.error("graceful shutdown failed", { err: String(err) });
          process.exit(1);
        });
    };
    process.once("SIGINT", handle);
    process.once("SIGTERM", handle);
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.running = false;
    log.info("worker stopping");
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.scheduler.stop();
    if (this.inFlightSession) {
      log.info("awaiting in-flight session before shutdown");
      try {
        await this.inFlightSession;
      } catch (err) {
        log.warn("in-flight session ended with error during shutdown", { err: String(err) });
      }
    }
    await this.agentSource.stop();
    await this.knowledgeSource.stop();
    await this.loopSource.stop();
    try {
      await closeDefaultDb();
    } catch {
      /* already closed */
    }
    log.info("worker stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  async status(): Promise<{
    running: boolean;
    startedAt: string | null;
    uptimeSec: number;
    counts: { agents: number; knowledge: number; loops: number };
  }> {
    return {
      running: this.running,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt
        ? Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000)
        : 0,
      counts: {
        agents: (await this.agentSource.list()).length,
        knowledge: (await this.knowledgeSource.list()).length,
        loops: (await this.loopSource.list()).length,
      },
    };
  }

  private async tickScheduler(): Promise<void> {
    const result = await this.scheduler.tick(new Date());
    if (result.fired > 0 || result.skipped > 0) {
      log.info("scheduler tick", { ...result });
    }
  }

  /**
   * Pick up queued wakeups and run them. Each wakeup spawns a session
   * via `@aaspai/sessions`, which records the result to the DB and
   * to `session_events`. The in-flight guard prevents overlap: a
   * 5s poll that fires while a previous session is still running
   * is dropped (not queued, not delayed) so we never have more
   * than one opencode.exe process at a time per worker.
   */
  private async pollWakeups(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.pollInFlight || this.inFlightSession) {
      log.debug("poll skipped: previous tick or session still in flight");
      return;
    }
    this.pollInFlight = true;
    try {
      const handle = getDefaultDb();
      const queued = await handle.db
        .select()
        .from(wakeupsTable)
        .where(eq(wakeupsTable.status, "queued"))
        .limit(10);

      for (const wakeup of queued) {
        if (this.shuttingDown) break;
        if (this.inFlightSession) break;
        this.inFlightSession = this.claimAndRun(wakeup.id)
          .catch((err) =>
            log.error("wakeup unhandled error", {
              wakeupId: wakeup.id,
              err: String(err),
            }),
          )
          .finally(() => {
            this.inFlightSession = null;
          });
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async claimAndRun(wakeupId: string): Promise<void> {
    const handle = getDefaultDb();

    // Atomic claim: only succeeds if the wakeup is still `queued`.
    // If another worker (or a stale poll from this same worker)
    // already claimed it, 0 rows are affected and we skip.
    const now = new Date().toISOString();
    const claimed = await handle.db
      .update(wakeupsTable)
      .set({ status: "claimed", claimedAt: now } as never)
      .where(and(eq(wakeupsTable.id, wakeupId), eq(wakeupsTable.status, "queued")))
      .returning({ id: wakeupsTable.id });

    if (claimed.length === 0) {
      log.debug("wakeup not claimable (already claimed or finished)", { wakeupId });
      return;
    }

    const maxAttempts = 3;
    const backoffsMs = [0, 1_000, 5_000];
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.shuttingDown) {
        await this.markFailed(wakeupId, "worker shutting down");
        return;
      }
      if (attempt > 0) {
        log.info("retrying wakeup after backoff", {
          wakeupId,
          attempt,
          backoffMs: backoffsMs[attempt],
        });
        await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
      }
      try {
        await this.executeWakeup(wakeupId);
        return;
      } catch (err) {
        lastError = err as Error;
        log.warn("wakeup attempt failed", { wakeupId, attempt, err: String(err) });
      }
    }
    log.error("wakeup exhausted retries", { wakeupId, err: String(lastError) });
    await this.markFailed(
      wakeupId,
      `exhausted retries: ${String(lastError?.message ?? lastError)}`,
    );
  }

  private async executeWakeup(wakeupId: string): Promise<void> {
    const handle = getDefaultDb();
    const sessionId = `sess_${randomUUID()}`;

    const wakeupRow = (
      await handle.db.select().from(wakeupsTable).where(eq(wakeupsTable.id, wakeupId)).limit(1)
    )[0];

    if (!wakeupRow) {
      log.warn("wakeup not found after claim", { wakeupId });
      return;
    }

    const payload = safeJsonParse(wakeupRow.payloadJson) ?? {};
    const agentId = wakeupRow.agentId ?? (payload as { agentId?: string }).agentId;
    if (!agentId) {
      log.warn("wakeup has no agentId", { wakeupId });
      await this.markFailed(wakeupId, "no agentId");
      return;
    }

    const prompt =
      (payload as { prompt?: string }).prompt ??
      `Worker-triggered wakeup for ${wakeupRow.loopId} (${wakeupRow.reason ?? "no reason"})`;

    // Resolve the agent's adapter from its config. Falls back to the
    // loop's configured adapter, then to dry_run_local as a last resort.
    let adapterType = "dry_run_local";
    try {
      const agent = await this.agentSource.get(agentId);
      if (agent.adapter) adapterType = agent.adapter;
    } catch {
      // Agent config not found; fall back to the loop's adapter
      try {
        const loop = await this.loopSource.get(wakeupRow.loopId);
        const loopAdapter = (loop as unknown as { agentAdapter?: string } | null)?.agentAdapter;
        if (loopAdapter) adapterType = loopAdapter;
      } catch {
        /* keep dry_run */
      }
    }

    log.info("running wakeup", { wakeupId, agentId, adapter: adapterType });

    const result = await this.sessions.execute({
      organizationId: this.organizationId,
      agentId,
      adapter: adapterType,
      runtime: { kind: "local" },
      prompt,
      config: {},
      skills: [],
      budget: {},
      idempotencyKey: sessionId,
      wakeupId,
      traceId: wakeupId,
    });

    await handle.db
      .update(wakeupsTable)
      .set({
        status: "completed",
        finishedAt: new Date().toISOString(),
        sessionId: result.sessionId,
        error: undefined,
      } as never)
      .where(eq(wakeupsTable.id, wakeupId));

    log.info("wakeup complete", { wakeupId, sessionId, status: result.status });
  }

  private async markFailed(wakeupId: string, reason: string): Promise<void> {
    const handle = getDefaultDb();
    await handle.db
      .update(wakeupsTable)
      .set({
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: reason,
      } as never)
      .where(eq(wakeupsTable.id, wakeupId));
  }

  private async recoverStaleClaims(): Promise<void> {
    const handle = getDefaultDb();
    const staleMs = 5 * 60_000;
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const stale = await handle.db
      .select()
      .from(wakeupsTable)
      .where(eq(wakeupsTable.status, "claimed"));

    let recovered = 0;
    for (const row of stale) {
      if (!row.claimedAt) continue;
      if (row.claimedAt > cutoff) continue;
      await this.markFailed(row.id, "stale claim: worker died before completing wakeup");
      recovered++;
    }
    if (recovered > 0) {
      log.warn("recovered stale wakeup claims on startup", { recovered, staleMs });
    }
  }
}

function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
