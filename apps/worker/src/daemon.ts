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
import { eq } from "drizzle-orm";

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

    log.info("worker started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    log.info("worker stopping");
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.scheduler.stop();
    await this.agentSource.stop();
    await this.knowledgeSource.stop();
    await this.loopSource.stop();
    await closeDefaultDb();
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
   * to `session_events`. Foundation slice: processes one wakeup at a
   * time per tick (single-replica). Phase 4 adds parallelism.
   */
  private async pollWakeups(): Promise<void> {
    const handle = getDefaultDb();
    const queued = await handle.db
      .select()
      .from(wakeupsTable)
      .where(eq(wakeupsTable.status, "queued"))
      .limit(10);

    for (const wakeup of queued) {
      try {
        await this.claimAndRun(wakeup.id);
      } catch (err) {
        log.error("wakeup failed", { wakeupId: wakeup.id, err: String(err) });
        await this.markFailed(wakeup.id, String(err));
      }
    }
  }

  private async claimAndRun(wakeupId: string): Promise<void> {
    const handle = getDefaultDb();
    await handle.db
      .update(wakeupsTable)
      .set({ status: "claimed", claimedAt: new Date().toISOString() } as never)
      .where(eq(wakeupsTable.id, wakeupId));

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
}

function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
