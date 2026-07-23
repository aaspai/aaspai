/**
 * Worker daemon — the long-lived process that actually runs the loop.
 *
 * Responsibilities (minimal):
 *   1. Watch the file system (agents/, knowledge/, loops/) → fresh config cache
 *   2. Tick the scheduler every `tickIntervalMs` → create durable loop runs
 *   3. Poll queued wakeups → convert them into durable loop runs
 *   4. Loop forever (until SIGINT/SIGTERM)
 *
 * What's NOT here (deferred):
 *   - Multi-replica leader election
 *   - Cross-process pub/sub for events
 *   - HTTP /healthz (Phase 4)
 *   - Webhooks
 *   - Job queue (Phase 4 — for now we use the wakeups table directly)
 */
import {
  closeDefaultDb,
  definitionRevisions,
  getDefaultDb,
  projects,
  repositories,
  wakeups as wakeupsTable,
} from "@aaspai/db";
import { DependencyScheduler, ExecutionStore } from "@aaspai/execution";
import {
  FileAgentConfigSource,
  FileKnowledgeSource,
  FileLoopConfigSource,
} from "@aaspai/file-loader";
import {
  KillSwitch,
  type LoopExecutionLineage,
  LoopRunner,
  PatternRegistry,
  Scheduler,
  STARTER_PATTERNS,
} from "@aaspai/loops";
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
  private readonly executionStore: ExecutionStore;
  private readonly executionScheduler: DependencyScheduler;
  private loopLineage: LoopExecutionLineage | null = null;

  private tickHandle: NodeJS.Timeout | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private inFlightWork: Promise<void> | null = null;
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
    this.executionStore = new ExecutionStore(getDefaultDb().db);
    this.executionScheduler = new DependencyScheduler(this.executionStore, {
      maxOrganizationConcurrency: 1,
      maxProjectConcurrency: 1,
      retryDelayMs: 1_000,
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
    this.loopLineage = await this.ensureLoopLineage();
    log.info("file sources ready", {
      agents: (await this.agentSource.list()).length,
      knowledge: (await this.knowledgeSource.list()).length,
      loops: (await this.loopSource.list()).length,
    });

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
      // Mark shuttingDown immediately so pollWakeups/claimAndRun bail.
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
    if (this.inFlightWork) {
      log.info("awaiting in-flight work before shutdown");
      try {
        await this.inFlightWork;
      } catch (err) {
        log.warn("in-flight work ended with error during shutdown", { err: String(err) });
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
    if (!this.loopLineage) return;
    const now = new Date();
    const due = this.scheduler.due(now);
    for (const resolved of due) {
      const runner = new LoopRunner({
        organizationId: this.organizationId,
        execution: { store: this.executionStore, lineage: this.loopLineage },
        killSwitch: this.killSwitch,
      });
      const result = await runner.run(resolved, {
        triggerKey: `scheduled:${now.toISOString().slice(0, 16)}`,
        now,
      });
      await this.executeWorkItems(result.runId, resolved.pattern.agent);
      log.info("durable loop tick", {
        loopId: resolved.pattern.id,
        runId: result.runId,
        workItems: result.workItems.length,
        outputs: result.outputs.length,
        stopped: result.stopped,
      });
    }
  }

  /**
   * Pick up queued wakeups and convert them into durable loop runs. The
   * in-flight guard prevents overlap in this worker; WorkItems are then
   * bounded by the execution scheduler and governance checks.
   */
  private async pollWakeups(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.pollInFlight || this.inFlightWork) {
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
        if (this.inFlightWork) break;
        this.inFlightWork = this.claimAndRun(wakeup.id)
          .catch((err) =>
            log.error("wakeup unhandled error", {
              wakeupId: wakeup.id,
              err: String(err),
            }),
          )
          .finally(() => {
            this.inFlightWork = null;
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

    const wakeupRow = (
      await handle.db.select().from(wakeupsTable).where(eq(wakeupsTable.id, wakeupId)).limit(1)
    )[0];

    if (!wakeupRow) {
      log.warn("wakeup not found after claim", { wakeupId });
      return;
    }

    const resolved = this.patternRegistry.get(wakeupRow.loopId);
    if (!resolved || !this.loopLineage) {
      await this.markFailed(wakeupId, "loop is not registered or execution lineage is unavailable");
      return;
    }
    const runner = new LoopRunner({
      organizationId: this.organizationId,
      execution: { store: this.executionStore, lineage: this.loopLineage },
      killSwitch: this.killSwitch,
    });
    const run = await runner.run(resolved, { triggerKey: `wakeup:${wakeupId}` });
    await this.executeWorkItems(run.runId, resolved.pattern.agent);

    await handle.db
      .update(wakeupsTable)
      .set({
        status: "completed",
        finishedAt: new Date().toISOString(),
        error: undefined,
      } as never)
      .where(eq(wakeupsTable.id, wakeupId));

    log.info("wakeup converted to durable loop run", {
      wakeupId,
      runId: run.runId,
      workItems: run.workItems.length,
      outputs: run.outputs.length,
    });
  }

  private async executeWorkItems(workflowRunId: string, agentId: string): Promise<void> {
    const agent = await this.agentSource.get(agentId).catch(() => null);
    const adapter = agent?.adapter ?? "dry_run_local";
    const run = await this.executionStore.getWorkflowRun(workflowRunId);
    if (!run) throw new Error(`Workflow run ${workflowRunId} not found`);
    await this.executionScheduler.run(
      {
        organizationId: this.organizationId,
        goalId: run.goalId,
        workflowRunId,
        agentId,
        harness: adapter,
        maxDispatch: 1,
      },
      async ({ workItem, attempt }) => {
        const metadata = workItem.metadata;
        const prompt =
          typeof metadata === "object" && metadata !== null && "decision" in metadata
            ? String((metadata as { decision?: unknown }).decision)
            : workItem.description;
        const result = await this.sessions.execute({
          organizationId: this.organizationId,
          agentId,
          adapter,
          runtime: { kind: "local" },
          prompt,
          config: {},
          skills: [],
          budget: {},
          idempotencyKey: attempt.id,
          traceId: workflowRunId,
        });
        return result.status === "succeeded" ? "succeeded" : "failed";
      },
      { maxTicks: 100 },
    );
  }

  private async ensureLoopLineage(): Promise<LoopExecutionLineage> {
    const handle = getDefaultDb();
    const suffix = this.organizationId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const goalId = `goal:loops:${suffix}`;
    const projectId = `project:loops:${suffix}`;
    const repositoryId = `repo:loops:${suffix}`;
    const definitionRevisionId = `revision:loops:${suffix}`;
    if (!(await this.executionStore.getGoal(goalId))) {
      await this.executionStore.createGoal({
        id: goalId,
        organizationId: this.organizationId,
        title: "Company loop execution",
        description: "Durable work generated by company loops.",
        status: "active",
      });
    }
    const project = await handle.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project[0]) {
      await this.executionStore.createProject({
        id: projectId,
        organizationId: this.organizationId,
        goalId,
        title: "Loop work",
        description: "Execution project for bounded loop actions.",
      });
    }
    const repository = await handle.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!repository[0]) {
      await this.executionStore.createRepository({
        id: repositoryId,
        organizationId: this.organizationId,
        projectId,
        purpose: "blueprint",
        provider: "local",
        localPath: process.env.AASPAI_DEFINITIONS_DIR ?? ".",
        defaultBranch: "main",
      });
    }
    const revision = await handle.db
      .select()
      .from(definitionRevisions)
      .where(eq(definitionRevisions.id, definitionRevisionId))
      .limit(1);
    if (!revision[0]) {
      await this.executionStore.createDefinitionRevision({
        id: definitionRevisionId,
        organizationId: this.organizationId,
        repositoryId,
        commitSha: "0000000",
        sourcePath: process.env.AASPAI_DEFINITIONS_DIR ?? ".",
        dirty: true,
        contentHash: "worker-loop-definition",
      });
    }
    return { goalId, projectId, repositoryId, definitionRevisionId };
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
    const lostAttempts = await new ExecutionStore(handle.db).reconcileLostAttempts(cutoff);
    if (lostAttempts > 0) log.warn("reconciled lost execution attempts", { lostAttempts, staleMs });
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
