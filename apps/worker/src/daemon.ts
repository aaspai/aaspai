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

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentAttempt, ExecutionWorkItem } from "@aaspai/contracts/execution";
import type { AdapterExecutionResult } from "@aaspai/contracts/harness";
import { resolvedAgentProfileSchema } from "@aaspai/contracts/profile";
import {
  closeDefaultDb,
  definitionRevisions,
  getDefaultDb,
  projects,
  repositories,
  wakeups as wakeupsTable,
} from "@aaspai/db";
import {
  AutonomousWorkExecutor,
  compileProfile,
  DependencyScheduler,
  ExecutionStore,
  HarnessExecutionPlanRunner,
  LocalExecutionWorkspaceManager,
} from "@aaspai/execution";
import {
  DEFAULT_AGENTS_DIR,
  DEFAULT_KNOWLEDGE_DIR,
  DEFAULT_LOOPS_DIR,
  FileAgentConfigSource,
  FileKnowledgeSource,
  FileLoopConfigSource,
} from "@aaspai/file-loader";
import { LocalGitRepository } from "@aaspai/git";
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
import { loadSkillDirectory, SkillRegistry } from "@aaspai/skills";
import { createBuiltInRegistry } from "@aaspai/tools";
import { and, eq } from "drizzle-orm";

const log = getLogger("worker.daemon");

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_WAKEUP_POLL_INTERVAL_MS = 5_000;

export interface DaemonOptions {
  tickIntervalMs?: number;
  wakeupPollIntervalMs?: number;
  organizationId?: string;
}

function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const ARTIFACT_KINDS = new Set([
  "diff",
  "patch",
  "log",
  "transcript",
  "test_result",
  "result",
  "other",
] as const);

interface DeclaredArtifact {
  path: string;
  kind: "diff" | "patch" | "log" | "transcript" | "test_result" | "result" | "other";
  mediaType: string;
}

interface AttemptCredential {
  id: string;
  token: string;
  expiresAt: string;
}

function declaredArtifacts(metadata: unknown): DeclaredArtifact[] {
  const value =
    metadata && typeof metadata === "object"
      ? (metadata as { declaredArtifacts?: unknown }).declaredArtifacts
      : undefined;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("metadata.declaredArtifacts must be an array of at most 32 files");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Declared artifact ${index} must be an object`);
    }
    const item = entry as { path?: unknown; kind?: unknown; mediaType?: unknown };
    if (typeof item.path !== "string" || !item.path.trim() || item.path.length > 8_192) {
      throw new Error(`Declared artifact ${index} has an invalid path`);
    }
    const kind = item.kind ?? "result";
    if (typeof kind !== "string" || !ARTIFACT_KINDS.has(kind as DeclaredArtifact["kind"])) {
      throw new Error(`Declared artifact ${index} has an invalid kind`);
    }
    if (
      item.mediaType !== undefined &&
      (typeof item.mediaType !== "string" || !item.mediaType.trim() || item.mediaType.length > 256)
    ) {
      throw new Error(`Declared artifact ${index} has an invalid mediaType`);
    }
    return {
      path: item.path,
      kind: kind as DeclaredArtifact["kind"],
      mediaType:
        item.mediaType ??
        (extname(item.path).toLowerCase() === ".html"
          ? "text/html"
          : extname(item.path).toLowerCase() === ".css"
            ? "text/css"
            : "application/octet-stream"),
    };
  });
}

async function issueAttemptCredential(
  organizationId: string,
  attemptId: string,
): Promise<AttemptCredential | null> {
  const baseUrl = process.env.AASPAI_GATEWAY_CONTROL_URL?.replace(/\/+$/, "");
  const controlToken = process.env.AASPAI_GATEWAY_CONTROL_TOKEN;
  if (!baseUrl && !controlToken) return null;
  if (!baseUrl || !controlToken) {
    throw new Error(
      "Both AASPAI_GATEWAY_CONTROL_URL and AASPAI_GATEWAY_CONTROL_TOKEN are required",
    );
  }
  const response = await fetch(`${baseUrl}/v1/attempt-credentials`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${controlToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ organizationId, attemptId }),
  });
  if (!response.ok) throw new Error(`Credential gateway issue failed (${response.status})`);
  const value = (await response.json()) as Partial<AttemptCredential>;
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.token !== "string" ||
    !value.token ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.now()
  ) {
    throw new Error("Credential gateway returned an invalid attempt credential");
  }
  return value as AttemptCredential;
}

async function revokeAttemptCredential(credential: AttemptCredential): Promise<void> {
  const baseUrl = process.env.AASPAI_GATEWAY_CONTROL_URL?.replace(/\/+$/, "");
  const controlToken = process.env.AASPAI_GATEWAY_CONTROL_TOKEN;
  if (!baseUrl || !controlToken) throw new Error("Credential gateway control config disappeared");
  const response = await fetch(
    `${baseUrl}/v1/attempt-credentials/${encodeURIComponent(credential.id)}`,
    {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${controlToken}` },
    },
  );
  if (!response.ok) throw new Error(`Credential gateway revoke failed (${response.status})`);
}

export class WorkerDaemon {
  private readonly tickIntervalMs: number;
  private readonly wakeupPollIntervalMs: number;
  private readonly organizationId: string;

  private readonly agentSource: FileAgentConfigSource;
  private readonly knowledgeSource: FileKnowledgeSource;
  private readonly loopSource: FileLoopConfigSource;
  private readonly scheduler: Scheduler;
  private readonly killSwitch: KillSwitch;
  private readonly patternRegistry: PatternRegistry;
  private readonly executionStore: ExecutionStore;
  private readonly executionScheduler: DependencyScheduler;
  private readonly autonomousExecutor: AutonomousWorkExecutor;
  private readonly git = new LocalGitRepository();
  /** Test/legacy compatibility seam; production always has the durable runner. */
  private readonly legacySessionExecutor?: (request: Record<string, unknown>) => Promise<{
    sessionId?: string;
    status?: string;
  }>;
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

    this.agentSource = new FileAgentConfigSource(
      process.env.AASPAI_AGENTS_DIR ?? DEFAULT_AGENTS_DIR,
    );
    this.knowledgeSource = new FileKnowledgeSource(
      process.env.AASPAI_KNOWLEDGE_DIR ?? DEFAULT_KNOWLEDGE_DIR,
    );
    this.loopSource = new FileLoopConfigSource(process.env.AASPAI_LOOPS_DIR ?? DEFAULT_LOOPS_DIR);
    const sessionFacade = new Sessions({
      agentSource: this.agentSource,
      knowledgeSource: this.knowledgeSource,
      // Legacy wakeups are compatibility-only; autonomous work uses compileProfile below.
      skillRegistry: new SkillRegistry(),
    });
    const compatibility = sessionFacade as unknown as {
      start?: unknown;
      execute?: (
        request: Record<string, unknown>,
      ) => Promise<{ sessionId?: string; status?: string }>;
    };
    if (typeof compatibility.start !== "function" && compatibility.execute) {
      this.legacySessionExecutor = compatibility.execute.bind(sessionFacade);
    }
    this.executionStore = new ExecutionStore(getDefaultDb().db);
    this.executionScheduler = new DependencyScheduler(this.executionStore, {
      maxOrganizationConcurrency: 1,
      maxProjectConcurrency: 1,
      retryDelayMs: 1_000,
    });
    this.autonomousExecutor = new AutonomousWorkExecutor(this.executionStore);

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
      // Compatibility seam for callers that invoke the private wakeup
      // machinery before start() provisions loop lineage. A started worker
      // always takes the durable path below.
      await this.executeLegacyWakeup(wakeupRow, wakeupId);
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

  private async executeLegacyWakeup(
    wakeupRow: typeof wakeupsTable.$inferSelect,
    wakeupId: string,
  ): Promise<void> {
    const payload = safeJsonParse(wakeupRow.payloadJson) ?? {};
    const agentId = wakeupRow.agentId ?? (payload as { agentId?: string }).agentId;
    if (!agentId) throw new Error("wakeup has no agentId");
    const adapter = "dry_run_local";
    const prompt =
      (payload as { prompt?: string }).prompt ??
      `Worker-triggered wakeup for ${wakeupRow.loopId} (${wakeupRow.reason ?? "no reason"})`;
    if (this.legacySessionExecutor) {
      const result = await this.legacySessionExecutor({
        organizationId: this.organizationId,
        agentId,
        adapter,
        runtime: { kind: "local" },
        prompt,
        config: {},
        skills: [],
        budget: {},
        idempotencyKey: wakeupId,
        wakeupId,
        traceId: wakeupId,
      });
      const handle = getDefaultDb();
      await handle.db
        .update(wakeupsTable)
        .set({
          status: "completed",
          finishedAt: new Date().toISOString(),
          sessionId: result.sessionId,
          error: undefined,
        } as never)
        .where(eq(wakeupsTable.id, wakeupId));
      return;
    }
    const lineage = this.loopLineage ?? (await this.ensureLoopLineage());
    const workItem = await this.executionStore.createWorkItem({
      id: `work:wakeup:${wakeupId}`,
      organizationId: this.organizationId,
      goalId: lineage.goalId,
      projectId: lineage.projectId,
      repositoryId: lineage.repositoryId,
      title: prompt.slice(0, 512),
      description: prompt,
      definitionRevisionId: lineage.definitionRevisionId,
      sourceCommitSha: "0000000",
      branchName: "worker-wakeup",
      idempotencyKey: wakeupId,
      status: "ready",
    });
    const workflowRun = await this.executionStore.createWorkflowRun({
      id: `run:wakeup:${wakeupId}`,
      organizationId: this.organizationId,
      goalId: lineage.goalId,
      definitionRevisionId: lineage.definitionRevisionId,
      sourceType: "wakeup",
      sourceId: wakeupId,
      idempotencyKey: `workflow:${wakeupId}`,
    });
    const attempt = await this.executionStore.createAttempt({
      id: `attempt:wakeup:${wakeupId}`,
      organizationId: this.organizationId,
      workflowRunId: workflowRun.id,
      workItemId: workItem.id,
      agentId,
      harness: adapter,
    });
    if (!(await this.executionStore.claimWorkItem(workItem.id, attempt.id))) {
      throw new Error(`Wakeup ${wakeupId} could not be claimed`);
    }
    const claimedWorkItem = await this.executionStore.getWorkItem(workItem.id);
    if (!claimedWorkItem) throw new Error(`Wakeup work item ${workItem.id} disappeared`);
    const result = await this.executeDurableAttempt({
      attempt,
      workItem: claimedWorkItem,
      agentId,
      adapter,
      prompt,
    });
    const legacyStatus = result.timedOut
      ? "failed"
      : result.exitCode === 0
        ? "completed"
        : "failed";
    await this.executionStore.updateWorkItemStatus(claimedWorkItem.id, legacyStatus, {
      blockedReason: legacyStatus === "completed" ? null : (result.errorMessage ?? result.summary),
    });
    const handle = getDefaultDb();
    await handle.db
      .update(wakeupsTable)
      .set({
        status: "completed",
        finishedAt: new Date().toISOString(),
        sessionId: result.sessionId,
        error: undefined,
      } as never)
      .where(eq(wakeupsTable.id, wakeupId));
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
        const result = await this.autonomousExecutor.execute({
          organizationId: this.organizationId,
          workflowRunId,
          workItemId: workItem.id,
          agentId,
          harness: adapter,
          attempt,
          runProvider: async () => {
            const result = await this.executeDurableAttempt({
              attempt,
              workItem,
              agentId,
              adapter,
              prompt,
            });
            return result.timedOut ? "timed_out" : result.exitCode === 0 ? "succeeded" : "failed";
          },
        });
        return result.attempt.status === "succeeded" ? "succeeded" : "failed";
      },
      { maxTicks: 100, executorOwnsAttempt: true },
    );
  }

  private async executeDurableAttempt(input: {
    attempt: AgentAttempt;
    workItem: ExecutionWorkItem;
    agentId: string;
    adapter: string;
    prompt: string;
  }): Promise<AdapterExecutionResult> {
    const persistedPlan = await this.executionStore.getPlanForAttempt(input.attempt.id);
    const profile = persistedPlan
      ? resolvedAgentProfileSchema.parse(persistedPlan.profileSnapshot)
      : await this.compileAutonomousProfile({
          agentId: input.agentId,
          adapter: input.adapter,
          prompt: input.prompt,
          definitionRevisionId: input.workItem.definitionRevisionId ?? "",
        });
    const skillRegistry = persistedPlan
      ? null
      : await loadSkillDirectory(process.env.AASPAI_SKILLS_DIR ?? "./skills");
    const repository = (
      await getDefaultDb()
        .db.select()
        .from(repositories)
        .where(
          and(
            eq(repositories.organizationId, this.organizationId),
            eq(repositories.id, input.workItem.repositoryId),
          ),
        )
        .limit(1)
    )[0];
    if (!repository) throw new Error(`Repository ${input.workItem.repositoryId} not found`);
    const workspaceManager = new LocalExecutionWorkspaceManager(
      this.git,
      this.executionStore,
      async (repositoryId) => {
        if (repositoryId !== repository.id) throw new Error("repository scope mismatch");
        return repository.localPath;
      },
    );
    const sourceCommit =
      input.workItem.sourceCommitSha && input.workItem.sourceCommitSha !== "0000000"
        ? input.workItem.sourceCommitSha
        : await this.git.resolveCommit(repository.localPath, repository.defaultBranch);
    const workspace = await workspaceManager.prepare({
      organizationId: this.organizationId,
      attemptId: input.attempt.id,
      repositoryId: repository.id,
      repositoryPath: repository.localPath,
      baseCommitSha: sourceCommit,
      workspaceRoot: process.env.AASPAI_WORKSPACE_ROOT ?? join("workspace", "worker"),
      branchName: input.workItem.branchName ?? `worker/${input.attempt.id}`,
    });
    const workspacePath = workspace.path;
    const materializedPaths: string[] = [];
    try {
      const materialization = await (skillRegistry ?? new SkillRegistry()).materialize(
        profile.skills.map((entry) => entry.skill),
        {
          adapterType: input.adapter,
          runtimeBaseDir: workspacePath,
          sharedHome: false,
          autonomous: true,
        },
      );
      if (materialization.errors.length > 0)
        throw new Error(`Skill materialization failed: ${materialization.errors.join("; ")}`);
      materializedPaths.push(...materialization.written, ...materialization.symlinked);
    } catch (error) {
      await workspaceManager.release(workspace.id).catch(() => undefined);
      throw error;
    }
    const adapterConfig = {
      ...profile.inputs.adapterConfig,
      ...(input.adapter === "opencode_cli" &&
      profile.skills.length > 0 &&
      !Array.isArray(profile.inputs.adapterConfig.skillsPaths)
        ? { skillsPaths: [".opencode_cli/skills"] }
        : {}),
    };
    let credential: AttemptCredential | null = null;
    let credentialRevoked = false;
    try {
      const plan =
        persistedPlan ??
        (await this.executionStore.createPlan({
          organizationId: this.organizationId,
          definitionRevisionId: input.workItem.definitionRevisionId ?? "revision:missing",
          workItemId: input.workItem.id,
          attemptId: input.attempt.id,
          sourceSnapshot: {
            repositoryId: input.workItem.repositoryId,
            commitSha: sourceCommit,
            branchName: input.workItem.branchName ?? "worker",
            capturedAt: new Date().toISOString(),
          },
          target: {
            ...profile.runtime.target,
            ...(profile.runtime.target.kind === "local" ? { cwd: workspacePath } : {}),
          },
          harness: input.adapter,
          agentId: input.agentId,
          idempotencyKey: input.attempt.id,
          prompt: input.prompt,
          harnessConfig: adapterConfig,
          runtimeConfig: { workspacePolicy: "disposable" },
          profile,
        }));
      credential = await issueAttemptCredential(this.organizationId, input.attempt.id);

      return await new HarnessExecutionPlanRunner(this.executionStore).run({
        plan,
        workspace: { ...workspace, status: "ready" },
        profile,
        ...(credential ? { ephemeralEnv: { AASPAI_ATTEMPT_TOKEN: credential.token } } : {}),
        onExecuted: async (result) => {
          if (credential) {
            await revokeAttemptCredential(credential);
            credentialRevoked = true;
          }
          await Promise.all(
            materializedPaths.map((path) => rm(path, { recursive: true, force: true })),
          );
          await this.persistAttemptOutput({
            result,
            attempt: input.attempt,
            workItem: input.workItem,
            workspacePath,
            sourceCommit,
          });
        },
      });
    } finally {
      if (credential && !credentialRevoked) {
        await revokeAttemptCredential(credential).catch((error) =>
          log.error("attempt credential revocation failed", {
            attemptId: input.attempt.id,
            err: String(error),
          }),
        );
      }
      await workspaceManager.release(workspace.id).catch(() => undefined);
    }
  }

  private async persistAttemptOutput(input: {
    result: AdapterExecutionResult;
    attempt: AgentAttempt;
    workItem: ExecutionWorkItem;
    workspacePath: string;
    sourceCommit: string;
  }): Promise<void> {
    const successful = input.result.exitCode === 0 && !input.result.timedOut;
    const commit = successful
      ? await this.git.commit(input.workspacePath, `aaspai attempt ${input.attempt.id}`)
      : null;
    const head = commit ?? (await this.git.resolveCommit(input.workspacePath));
    const patch = await this.git.diff(input.workspacePath, input.sourceCommit, head);
    const attemptRoot = resolve(
      process.env.AASPAI_ARTIFACTS_ROOT ?? join(".aaspai", "artifacts"),
      input.attempt.id,
    );
    await mkdir(attemptRoot, { recursive: true });
    if (patch) {
      const patchPath = join(attemptRoot, "changes.patch");
      await writeFile(patchPath, patch, "utf8");
      await this.recordArtifact(input.attempt.id, "patch", patchPath, "text/x-diff");
    }

    const workspaceRoot = await realpath(input.workspacePath);
    for (const declaration of declaredArtifacts(input.workItem.metadata)) {
      if (isAbsolute(declaration.path)) throw new Error("Declared artifact path must be relative");
      const source = await realpath(resolve(workspaceRoot, declaration.path));
      const safePath = relative(workspaceRoot, source);
      if (!safePath || safePath.startsWith("..") || isAbsolute(safePath)) {
        throw new Error(`Declared artifact escapes the workspace: ${declaration.path}`);
      }
      if (!(await stat(source)).isFile()) {
        throw new Error(`Declared artifact is not a file: ${declaration.path}`);
      }
      const destination = join(attemptRoot, "files", safePath);
      await mkdir(resolve(destination, ".."), { recursive: true });
      await copyFile(source, destination);
      await this.recordArtifact(
        input.attempt.id,
        declaration.kind,
        destination,
        declaration.mediaType,
      );
    }
  }

  private async recordArtifact(
    attemptId: string,
    kind: DeclaredArtifact["kind"],
    path: string,
    mediaType: string,
  ): Promise<void> {
    const bytes = await readFile(path);
    await this.executionStore.createArtifact({
      organizationId: this.organizationId,
      attemptId,
      kind,
      path,
      mediaType,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  private async compileAutonomousProfile(input: {
    agentId: string;
    adapter: string;
    prompt: string;
    definitionRevisionId: string;
  }) {
    const definitionRevision = await this.executionStore.getDefinitionRevision(
      input.definitionRevisionId,
    );
    if (!definitionRevision) throw new Error("Definition revision missing");
    const skillRegistry = await loadSkillDirectory(process.env.AASPAI_SKILLS_DIR ?? "./skills");
    return compileProfile({
      organizationId: this.organizationId,
      agentId: input.agentId,
      definitionRevision,
      agentSource: this.agentSource,
      knowledgeSource: this.knowledgeSource,
      skillRegistry,
      toolRegistry: createBuiltInRegistry(),
      adapter: input.adapter,
      prompt: input.prompt,
    });
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
