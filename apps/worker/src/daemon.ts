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
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  CompanyCommandService,
  CompanyControlPlaneService,
  CompanyOperationsService,
  OperationalGovernanceService,
} from "@aaspai/company";
import type { AgentConfig } from "@aaspai/contracts";
import type { AgentAttempt, ExecutionWorkItem } from "@aaspai/contracts/execution";
import type { AdapterExecutionResult } from "@aaspai/contracts/harness";
import { resolvedAgentProfileSchema } from "@aaspai/contracts/profile";
import { executionTargetSchema } from "@aaspai/contracts/runtime";
import {
  closeDefaultDb,
  companyProfiles,
  definitionRevisions,
  executionOperatorRuns,
  getDefaultDb,
  loops,
  milestones,
  projectAssignments,
  projects,
  repositories,
  runMigrations,
  sessions as sessionsTable,
  wakeups as wakeupsTable,
} from "@aaspai/db";
import {
  AutonomousWorkExecutor,
  assertGovernedRuntimeIsolation,
  compileProfile,
  DependencyScheduler,
  ExecutionStore,
  evaluateExecutionPolicy,
  HarnessExecutionPlanRunner,
  LocalExecutionWorkspaceManager,
  OperatorService,
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
import { KnowledgeCurator } from "@aaspai/knowledge";
import {
  KillSwitch,
  LoopControlStore,
  type LoopExecutionLineage,
  LoopRunner,
  PatternRegistry,
  resolveFilePattern,
  Scheduler,
  STARTER_PATTERNS,
  StateStore,
} from "@aaspai/loops";
import { createLocalMemoryProvider } from "@aaspai/memory";
import { COMPANY_TOOL_CATALOG, getLogger } from "@aaspai/observability";
import { Sessions } from "@aaspai/sessions";
import { loadSkillDirectory, SkillRegistry } from "@aaspai/skills";
import { createBuiltInRegistry } from "@aaspai/tools";
import { and, eq } from "drizzle-orm";
import { BROWSER_SNAPSHOT_TOOL_SOURCE } from "./browser-tool.js";
import {
  COMPANY_ACTION_TOOL_SOURCE,
  type CompanyAction,
  companyActions,
  type HireAndDelegateAction,
  missingRequiredCompanyActions,
} from "./company-actions.js";
import { validateEvidencePolicy } from "./output-policy.js";

const log = getLogger("worker.daemon");

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_WAKEUP_POLL_INTERVAL_MS = 5_000;

function hiredAgentTools(tools: AgentConfig["tools"], role: HireAndDelegateAction["role"]) {
  const source = tools && typeof tools === "object" ? (tools as Record<string, unknown>) : {};
  const allowedForRole = new Set([
    "apply_patch",
    "bash",
    "edit",
    "glob",
    "grep",
    "list",
    "read",
    "shell",
    "skill",
    "view_image",
    "web_search",
    "write",
    ...(role === "cmo" || role === "researcher" ? ["browser_snapshot", "websearch"] : []),
  ]);
  const allow = Array.isArray(source.allow)
    ? source.allow.filter(
        (tool): tool is string =>
          typeof tool === "string" && allowedForRole.has(tool.toLowerCase()),
      )
    : [];
  const allowed = new Set(allow.map((tool) => tool.toLowerCase()));
  return {
    allow,
    deny: Array.isArray(source.deny)
      ? source.deny.filter((tool): tool is string => typeof tool === "string")
      : [],
    require_approval_for: Array.isArray(source.require_approval_for)
      ? source.require_approval_for.filter(
          (tool): tool is string => typeof tool === "string" && allowed.has(tool.toLowerCase()),
        )
      : [],
  };
}

function parsePortfolioProposal(
  summary: string | undefined,
): { summary: string; projects: unknown[] } | null {
  const json = summary?.match(/^AASPAI_PORTFOLIO_PROPOSAL=(\{.*\})$/m)?.[1];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return typeof parsed.summary === "string" && Array.isArray(parsed.projects)
      ? { summary: parsed.summary, projects: parsed.projects }
      : null;
  } catch {
    return null;
  }
}

async function hashAgentDefinition(directory: string): Promise<string> {
  const files = ["AGENT.md", "config.yaml", "relations.yaml", "skills.lock.json", "tools.yaml"];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(directory, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function changedPathsFromStatus(entries: readonly string[]): string[] {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry
          .slice(3)
          .split(" -> ")
          .map((path) => path.replace(/^"|"$/g, "").replace(/\\/g, "/"))
          .filter(Boolean),
      ),
    ),
  ];
}

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

function outputMediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".csv":
      return "text/csv";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

interface DeclaredArtifact {
  path: string;
  kind: "diff" | "patch" | "log" | "transcript" | "test_result" | "result" | "other";
  mediaType: string;
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
    const kind = item.kind ?? "other";
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

async function listWorkspaceFiles(
  root: string,
  directory = root,
  paths: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      directory === root &&
      entry.isDirectory() &&
      [".codex", ".opencode_cli"].includes(entry.name)
    ) {
      continue;
    }
    if (paths.length >= 1_024) {
      throw new Error("Checker workspace file limit exceeded");
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await listWorkspaceFiles(root, path, paths);
    else paths.push(relative(root, path).replace(/\\/g, "/"));
  }
  return paths.sort();
}

export interface CheckerVerdict {
  status: "passed" | "failed" | "concerns";
  summary: string;
}

export function parseCheckerVerdict(output: string | undefined): CheckerVerdict | null {
  const line = output
    ?.split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.trim().startsWith("AASPAI_CHECK_RESULT="));
  if (!line) return null;
  try {
    const value = JSON.parse(line.trim().slice("AASPAI_CHECK_RESULT=".length)) as {
      verdict?: unknown;
      summary?: unknown;
    };
    if (
      !["passed", "failed", "concerns"].includes(String(value.verdict)) ||
      typeof value.summary !== "string" ||
      !value.summary.trim()
    ) {
      return null;
    }
    return {
      status: value.verdict as CheckerVerdict["status"],
      summary: value.summary.trim().slice(0, 8_192),
    };
  } catch {
    return null;
  }
}

export function requiredCheckerCommit(
  workItem: Pick<ExecutionWorkItem, "deliveryCommitSha">,
): string {
  if (!workItem.deliveryCommitSha) {
    throw new Error("Checker requires the maker's immutable delivery commit");
  }
  return workItem.deliveryCommitSha;
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
  private readonly loopControlStore: LoopControlStore;
  private readonly stateStore: StateStore;
  private readonly patternRegistry: PatternRegistry;
  private readonly executionStore: ExecutionStore;
  private readonly executionScheduler: DependencyScheduler;
  private readonly autonomousExecutor: AutonomousWorkExecutor;
  private readonly git = new LocalGitRepository();
  /** Test/legacy compatibility seam; production always has the durable runner. */
  private readonly legacySessionExecutor?: (request: Record<string, unknown>) => Promise<{
    sessionId?: string;
    status?: string;
    summary?: string;
  }>;
  private loopLineage: LoopExecutionLineage | null = null;
  private unwatchAgents: (() => void) | null = null;
  private unwatchLoops: (() => void) | null = null;
  private agentReconcile: Promise<void> = Promise.resolve();

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
      ) => Promise<{ sessionId?: string; status?: string; summary?: string }>;
    };
    if (typeof compatibility.start !== "function" && compatibility.execute) {
      this.legacySessionExecutor = compatibility.execute.bind(sessionFacade);
    }
    this.executionStore = new ExecutionStore(getDefaultDb().db);
    this.loopControlStore = new LoopControlStore(getDefaultDb().db);
    this.stateStore = new StateStore(getDefaultDb().db);
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
      controlStore: this.loopControlStore,
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

    runMigrations(getDefaultDb());
    await this.agentSource.start();
    await this.knowledgeSource.start();
    await this.loopSource.start();
    await this.reconcileAgentDefinitions();
    this.unwatchAgents = this.agentSource.watch(() => {
      this.agentReconcile = this.agentReconcile
        .then(() => this.reconcileAgentDefinitions())
        .catch((err) => log.error("agent relationship refresh failed", { err: String(err) }));
    });
    const prunedMemories = await createLocalMemoryProvider(getDefaultDb().db).pruneExpired(
      this.organizationId,
    );
    if (prunedMemories > 0) log.info("expired memory pruned", { prunedMemories });
    for (const id of await this.loopSource.list()) await this.refreshFileLoop(id);
    this.unwatchLoops = this.loopSource.watch((change) => {
      this.refreshFileLoop(change.id).catch((err) =>
        log.error("file loop refresh failed", { id: change.id, err: String(err) }),
      );
    });
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
    this.unwatchAgents?.();
    this.unwatchAgents = null;
    this.unwatchLoops?.();
    this.unwatchLoops = null;
    this.scheduler.stop();
    if (this.inFlightWork) {
      log.info("awaiting in-flight work before shutdown");
      try {
        await this.inFlightWork;
      } catch (err) {
        log.warn("in-flight work ended with error during shutdown", { err: String(err) });
      }
    }
    await this.agentReconcile;
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

  private async reconcileAgentDefinitions(): Promise<void> {
    const definitions = await Promise.all(
      (await this.agentSource.list()).map(async (id) => {
        const agent = await this.agentSource.get(id);
        return {
          id: agent.id,
          reportsTo: agent.reportsTo,
          manages: agent.manages,
          peers: agent.peers,
          metadata: { definitionSource: "git" },
        };
      }),
    );
    await new OperationalGovernanceService(getDefaultDb().db).reconcileAgentDefinitions(
      this.organizationId,
      definitions,
    );
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
    const due = await this.scheduler.dueOccurrences(now);
    for (const { resolved, key, scheduledAt } of due) {
      const runner = new LoopRunner({
        organizationId: this.organizationId,
        execution: { store: this.executionStore, lineage: this.loopLineage },
        killSwitch: this.killSwitch,
        controlStore: this.loopControlStore,
        stateStore: this.stateStore,
      });
      const result = await runner.run(resolved, {
        triggerKey: key,
        now: scheduledAt,
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

  private async refreshFileLoop(id: string): Promise<void> {
    const starter = STARTER_PATTERNS.find((candidate) => candidate.pattern.id === id);
    if (await this.loopSource.has(id)) {
      this.patternRegistry.register(resolveFilePattern(await this.loopSource.get(id), starter));
    } else if (starter) {
      this.patternRegistry.register(starter);
    } else {
      this.patternRegistry.unregister(id);
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
      await this.enqueueDueManagerRuns();
      const handle = getDefaultDb();
      const queued = await handle.db
        .select()
        .from(wakeupsTable)
        .where(
          and(
            eq(wakeupsTable.organizationId, this.organizationId),
            eq(wakeupsTable.status, "queued"),
          ),
        )
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
      .where(
        and(
          eq(wakeupsTable.id, wakeupId),
          eq(wakeupsTable.organizationId, this.organizationId),
          eq(wakeupsTable.status, "queued"),
        ),
      )
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
    if (wakeupRow.organizationId !== this.organizationId) {
      throw new Error(`wakeup ${wakeupId} belongs to another organization`);
    }

    const controlPayload = (safeJsonParse(wakeupRow.payloadJson) ?? {}) as Record<string, unknown>;
    if (typeof controlPayload.operatorRunId === "string") {
      const result = await new OperatorService(this.executionStore).tick(
        {
          organizationId: this.organizationId,
          actorId: "worker",
          correlationId: wakeupId,
        },
        controlPayload.operatorRunId,
      );
      if (result.decision?.action === "dispatch" && result.run.workflowRunId) {
        await this.executeManagerWorkItem(
          result.run.workflowRunId,
          result.decision.targetId,
          result.run.operatorAgentId,
        );
        await this.queueManagerWake(
          result.run.id,
          result.run.operatorAgentId,
          result.run.observedStateVersion,
          "Manager work item finished",
        );
      } else if (result.decision?.action === "complete" && result.run.workflowRunId) {
        await this.finalizeManagerRun(
          result.run.id,
          result.run.workflowRunId,
          result.run.operatorAgentId,
        );
      }
      await this.finishWakeup(wakeupId);
      return;
    }

    // Company commands already performed their durable state mutation before
    // emitting this wakeup. Only discovery needs another agent turn; the rest
    // are notifications, not new repository work.
    if (
      typeof controlPayload.command === "string" &&
      controlPayload.command !== "start_discovery"
    ) {
      await this.finishWakeup(wakeupId);
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
      controlStore: this.loopControlStore,
      stateStore: this.stateStore,
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
    const payload = (safeJsonParse(wakeupRow.payloadJson) ?? {}) as Record<string, unknown>;
    const request = payload as {
      agentId?: string;
      adapter?: string;
      runtime?: unknown;
      prompt?: string;
      sessionId?: string;
      workItemId?: string;
      workflowRunId?: string;
      resumeSessionId?: string;
      requiredCompanyActions?: unknown;
    };
    const agentId = wakeupRow.agentId ?? request.agentId;
    if (!agentId) throw new Error("wakeup has no agentId");
    const adapter = request.adapter ?? "dry_run_local";
    const runtime =
      request.runtime === undefined ? undefined : executionTargetSchema.parse(request.runtime);
    const prompt =
      request.prompt ??
      `Worker-triggered wakeup for ${wakeupRow.loopId} (${wakeupRow.reason ?? "no reason"})`;
    if (request.workItemId && request.workflowRunId) {
      const result = await this.autonomousExecutor.execute({
        organizationId: this.organizationId,
        workflowRunId: request.workflowRunId,
        workItemId: request.workItemId,
        agentId,
        harness: adapter,
        runProvider: async ({ attempt, workItem }) => {
          const executed = await this.executeDurableAttempt({
            attempt,
            workItem,
            agentId,
            adapter,
            prompt,
            runtime,
            durableSessionId: request.sessionId,
            resumeSessionId: request.resumeSessionId,
          });
          return {
            status: executed.timedOut
              ? ("timed_out" as const)
              : executed.exitCode === 0
                ? ("succeeded" as const)
                : ("failed" as const),
            usage: {
              tokens: (executed.usage?.inputTokens ?? 0) + (executed.usage?.outputTokens ?? 0),
              costUsd: executed.costUsd,
            },
          };
        },
      });
      await this.verifyPendingWorkItems(request.workflowRunId);
      if (result.workItem.status === "ready") {
        const harnessSession = result.attempt.harnessSessionId
          ? await this.executionStore.getHarnessSession(result.attempt.harnessSessionId)
          : null;
        await this.queueRetryWakeup(wakeupRow, request, result.attempt.attemptNumber + 1, {
          ...(result.attempt.status === "timed_out" && harnessSession?.sessionId
            ? { resumeSessionId: harnessSession.sessionId }
            : {}),
        });
      }
      await this.finishWakeup(wakeupId, request.sessionId ?? result.attempt.harnessSessionId);
      return;
    }
    if (this.legacySessionExecutor) {
      const result = await this.legacySessionExecutor({
        organizationId: this.organizationId,
        agentId,
        adapter,
        runtime: runtime ?? { kind: "local" },
        prompt,
        config: {},
        skills: [],
        budget: {},
        idempotencyKey: wakeupId,
        wakeupId,
        traceId: wakeupId,
        durableSessionId: request.sessionId,
      });
      if (!["succeeded", "completed"].includes(result.status ?? "")) {
        throw new Error(
          `session ${result.sessionId ?? request.sessionId ?? "unknown"} ${result.status ?? "failed"}`,
        );
      }
      await this.applyDiscoveryProposal(
        payload,
        result.summary,
        result.sessionId ?? request.sessionId ?? wakeupId,
        wakeupId,
      );
      await this.finishWakeup(wakeupId, result.sessionId ?? request.sessionId);
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
      metadata: Array.isArray(request.requiredCompanyActions)
        ? { requiredCompanyActions: request.requiredCompanyActions }
        : {},
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
      runtime,
      durableSessionId: request.sessionId,
    });
    const legacyStatus = result.timedOut
      ? "failed"
      : result.exitCode === 0
        ? "completed"
        : "failed";
    await this.executionStore.updateWorkItemStatus(claimedWorkItem.id, legacyStatus, {
      blockedReason: legacyStatus === "completed" ? null : (result.errorMessage ?? result.summary),
    });
    if (legacyStatus === "completed") {
      await this.applyDiscoveryProposal(
        payload,
        result.summary,
        result.sessionId ?? request.sessionId ?? wakeupId,
        wakeupId,
      );
    }
    await this.finishWakeup(wakeupId, result.sessionId ?? request.sessionId);
  }

  private async applyDiscoveryProposal(
    payload: Record<string, unknown>,
    summary: string | undefined,
    sessionId: string,
    wakeupId: string,
  ): Promise<void> {
    if (payload.command !== "start_discovery") return;
    const proposal = parsePortfolioProposal(summary);
    if (!proposal) throw new Error("CEO discovery did not return AASPAI_PORTFOLIO_PROPOSAL");
    await new CompanyCommandService(getDefaultDb().db).execute({
      type: "submit_portfolio_proposal",
      organizationId: this.organizationId,
      actorId: typeof payload.operatorAgentId === "string" ? payload.operatorAgentId : "agent/ceo",
      idempotencyKey: `discovery-proposal:${wakeupId}`,
      summary: proposal.summary,
      evidence: [`session/${sessionId}`],
      projects: proposal.projects,
    });
  }

  private async finishWakeup(wakeupId: string, sessionId?: string | null): Promise<void> {
    await getDefaultDb()
      .db.update(wakeupsTable)
      .set({
        status: "completed",
        finishedAt: new Date().toISOString(),
        sessionId: sessionId ?? undefined,
        error: undefined,
      } as never)
      .where(eq(wakeupsTable.id, wakeupId));
  }

  private async queueRetryWakeup(
    wakeup: typeof wakeupsTable.$inferSelect,
    request: {
      adapter?: string;
      runtime?: unknown;
      prompt?: string;
      workItemId?: string;
      workflowRunId?: string;
      sessionId?: string;
    },
    attemptNumber: number,
    retry: { resumeSessionId?: string },
  ): Promise<void> {
    const agentId = wakeup.agentId;
    if (!request.workItemId || !request.workflowRunId || !agentId) return;
    const suffix = createHash("sha256")
      .update(`${request.workItemId}\0${attemptNumber}`)
      .digest("hex")
      .slice(0, 32);
    const sessionId = `sess_retry_${suffix}`;
    const wakeupId = `wake_retry_${suffix}`;
    const requestedAt = new Date().toISOString();
    getDefaultDb().db.transaction((tx) => {
      tx.insert(wakeupsTable)
        .values({
          id: wakeupId,
          organizationId: this.organizationId,
          loopId: wakeup.loopId,
          source: "system",
          triggerDetail: "attempt-retry",
          reason: `Retry ${attemptNumber} for ${request.workItemId}`,
          agentId,
          payloadJson: JSON.stringify({
            ...request,
            sessionId,
            ...retry,
          }),
          status: "queued",
          idempotencyKey: `retry:${request.workItemId}:${attemptNumber}`,
          requestedAt,
          requestedByActorId: "system/recovery",
          requestedByActorType: "system",
        } as never)
        .onConflictDoNothing()
        .run();
      tx.insert(sessionsTable)
        .values({
          id: sessionId,
          organizationId: this.organizationId,
          wakeupId,
          agentId,
          adapter: request.adapter ?? "dry_run_local",
          runtimeJson: JSON.stringify(request.runtime ?? {}),
          prompt: request.prompt ?? `Retry ${request.workItemId}`,
          configJson: "{}",
          status: "queued",
          ...(request.sessionId ? { parentSessionId: request.sessionId } : {}),
        })
        .onConflictDoNothing()
        .run();
    });
  }

  private async resumeStalledSession(workItemId: string): Promise<string | undefined> {
    const previous = (await this.executionStore.listAttemptsForWorkItem(workItemId))
      .filter((attempt) => attempt.status === "timed_out" && attempt.harnessSessionId)
      .at(-1);
    if (!previous?.harnessSessionId) return undefined;
    return (
      (await this.executionStore.getHarnessSession(previous.harnessSessionId))?.sessionId ??
      undefined
    );
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
              resumeSessionId: await this.resumeStalledSession(workItem.id),
            });
            return {
              status: result.timedOut
                ? ("timed_out" as const)
                : result.exitCode === 0
                  ? ("succeeded" as const)
                  : ("failed" as const),
              usage: {
                tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
                costUsd: result.costUsd,
              },
            };
          },
        });
        return result.attempt.status === "succeeded" ? "succeeded" : "failed";
      },
      { maxTicks: 100, executorOwnsAttempt: true },
    );
    await this.verifyPendingWorkItems(workflowRunId);
  }

  private async executeManagerWorkItem(
    workflowRunId: string,
    workItemId: string | null,
    managerAgentId: string,
  ): Promise<void> {
    if (!workItemId) throw new Error("manager dispatch has no work item");
    const workItem = await this.executionStore.getWorkItem(workItemId, {
      organizationId: this.organizationId,
      actorId: managerAgentId,
      correlationId: workflowRunId,
    });
    if (!workItem || workItem.workflowRunId !== workflowRunId)
      throw new Error("manager dispatch target is outside its workflow");
    const assignedAgentId = workItem.assignedAgentId ?? managerAgentId;
    const agent = await this.agentSource.get(assignedAgentId);
    await this.autonomousExecutor.execute({
      organizationId: this.organizationId,
      workflowRunId,
      workItemId,
      agentId: assignedAgentId,
      harness: agent.adapter,
      runProvider: async ({ attempt }) => {
        const result = await this.executeDurableAttempt({
          attempt,
          workItem,
          agentId: assignedAgentId,
          adapter: agent.adapter,
          prompt: workItem.description,
          resumeSessionId: await this.resumeStalledSession(workItem.id),
        });
        return {
          status: result.timedOut
            ? ("timed_out" as const)
            : result.exitCode === 0
              ? ("succeeded" as const)
              : ("failed" as const),
          usage: {
            tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
            costUsd: result.costUsd,
          },
        };
      },
    });
    await this.verifyPendingWorkItems(workflowRunId);
  }

  private async queueManagerWake(
    managerRunId: string,
    managerAgentId: string,
    stateVersion: number,
    reason: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const loopId = `loop/manager/${this.organizationId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const key = `manager:${managerRunId}:${stateVersion}`;
    const db = getDefaultDb().db;
    db.transaction((tx) => {
      tx.insert(loops)
        .values({
          id: loopId,
          organizationId: this.organizationId,
          patternId: "manager",
          configJson: "{}",
          gateJson: "{}",
          budgetJson: "{}",
          scheduleJson: "{}",
          paused: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      tx.insert(wakeupsTable)
        .values({
          id: `wake/manager/${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
          organizationId: this.organizationId,
          loopId,
          source: "continuation",
          triggerDetail: "manager",
          reason,
          agentId: managerAgentId,
          payloadJson: JSON.stringify({ managerRunId, operatorRunId: managerRunId }),
          status: "queued",
          idempotencyKey: key,
          requestedAt: timestamp,
          requestedByActorId: "worker",
          requestedByActorType: "system",
        })
        .onConflictDoNothing()
        .run();
    });
  }

  private async finalizeManagerRun(
    managerRunId: string,
    workflowRunId: string,
    managerAgentId: string,
  ): Promise<void> {
    const items = await this.executionStore.listWorkItemsForWorkflow(
      this.organizationId,
      workflowRunId,
    );
    if (items.length === 0 || items.some((item) => item.status !== "completed"))
      throw new Error("Manager run cannot roll up incomplete work");
    const evidence: string[] = [];
    for (const item of items) {
      const verification = await this.executionStore.getVerificationForWorkItem(item.id);
      if (verification?.status !== "passed")
        throw new Error(`Manager work ${item.id} has no passed verification`);
      evidence.push(verification.id);
    }
    const milestoneIds = [...new Set(items.map((item) => item.milestoneId).filter(Boolean))];
    if (milestoneIds.length !== 1)
      throw new Error("Manager process must align to exactly one milestone");
    const projectId = items[0]?.projectId;
    if (!projectId) throw new Error("Manager process has no project");
    const commands = new CompanyCommandService(getDefaultDb().db);
    await commands.execute({
      type: "record_milestone_evaluation",
      organizationId: this.organizationId,
      actorId: managerAgentId,
      idempotencyKey: `manager-rollup:${managerRunId}:${milestoneIds[0]}`,
      projectId,
      milestoneId: milestoneIds[0] as string,
      status: "accepted",
      evidence,
      rationale: "All milestone process steps passed independent verification.",
    });
    const projectMilestones = await getDefaultDb()
      .db.select({ status: milestones.status })
      .from(milestones)
      .where(
        and(
          eq(milestones.organizationId, this.organizationId),
          eq(milestones.projectId, projectId),
        ),
      );
    if (!projectMilestones.every((milestone) => milestone.status === "accepted")) return;
    await commands.execute({
      type: "evaluate_project",
      organizationId: this.organizationId,
      actorId: managerAgentId,
      idempotencyKey: `manager-rollup:${managerRunId}:project`,
      projectId,
      evidence,
    });
    const [project] = await getDefaultDb()
      .db.select({ goalId: projects.goalId })
      .from(projects)
      .where(and(eq(projects.organizationId, this.organizationId), eq(projects.id, projectId)))
      .limit(1);
    const [profile] = await getDefaultDb()
      .db.select({ ceoAgentId: companyProfiles.ceoAgentId })
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, this.organizationId))
      .limit(1);
    if (project?.goalId && profile?.ceoAgentId) {
      await commands.execute({
        type: "evaluate_objective",
        organizationId: this.organizationId,
        actorId: profile.ceoAgentId,
        idempotencyKey: `manager-rollup:${managerRunId}:objective`,
        goalId: project.goalId,
        evidence,
      });
    }
  }

  private async enqueueDueManagerRuns(): Promise<void> {
    const rows = await getDefaultDb()
      .db.select()
      .from(executionOperatorRuns)
      .where(eq(executionOperatorRuns.organizationId, this.organizationId));
    const timestamp = new Date().toISOString();
    for (const run of rows) {
      if (run.status !== "waiting" || !run.wakeAt || run.wakeAt > timestamp) continue;
      await this.queueManagerWake(
        run.id,
        run.operatorAgentId,
        run.observedStateVersion,
        "Scheduled manager review",
      );
    }
  }

  private async verifyPendingWorkItems(workflowRunId: string): Promise<void> {
    const items = await this.executionStore.listWorkItemsForWorkflow(
      this.organizationId,
      workflowRunId,
      "awaiting_verification",
    );
    for (const workItem of items) {
      const verification = await this.executionStore.getVerificationForWorkItem(workItem.id);
      if (verification?.status !== "pending") continue;
      const checkerAgentId = workItem.governance.verification.checkerAgentId ?? "agent/tester";
      const checkerAgent = await this.agentSource.get(checkerAgentId);
      const checkerHarness =
        workItem.governance.verification.checkerHarness ?? checkerAgent.adapter;
      const checker = await this.executionStore.createCheckerAttempt({
        verificationId: verification.id,
        agentId: checkerAgentId,
        harness: checkerHarness,
      });
      const prompt = [
        "Independently verify the maker's committed change.",
        `Work item: ${workItem.title}`,
        workItem.description,
        ...workItem.governance.verification.acceptanceCriteria.map(
          (criterion) => `Acceptance: ${criterion.description}`,
        ),
        "Inspect the diff and run the smallest relevant tests. Do not modify files.",
        'End with exactly one line: AASPAI_CHECK_RESULT={"verdict":"passed|failed|concerns","summary":"brief evidence-based conclusion"}',
      ]
        .filter(Boolean)
        .join("\n\n");
      try {
        await this.executionStore.startCheckerAttempt(checker.id);
        const result = await this.executeDurableAttempt({
          attempt: checker,
          workItem,
          agentId: checkerAgentId,
          adapter: checkerHarness,
          prompt,
        });
        const verdict =
          !result.timedOut && result.exitCode === 0
            ? parseCheckerVerdict(result.summary)
            : {
                status: "failed" as const,
                summary:
                  result.errorMessage ??
                  result.summary ??
                  (result.timedOut
                    ? "Independent checker timed out"
                    : "Independent checker failed"),
              };
        const evidence = await this.executionStore.listArtifacts(checker.id);
        await this.executionStore.submitVerification({
          verificationId: verification.id,
          checkerAttemptId: checker.id,
          status: verdict?.status ?? "failed",
          summary:
            verdict?.summary ??
            "Checker completed without the required structured AASPAI_CHECK_RESULT verdict",
          evidenceIds: evidence.map((artifact) => artifact.id),
        });
        if (verdict?.status === "passed") {
          await this.proposeKnowledgeWriteback(workItem, checker.id, verdict.summary);
        }
      } catch (error) {
        const current = await this.executionStore.getAttempt(checker.id);
        if (
          current &&
          !["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(current.status)
        ) {
          if (current.status === "queued" || current.status === "preparing") {
            await this.executionStore.startCheckerAttempt(checker.id);
          }
          await this.executionStore.transitionAttempt(checker.id, "failed");
        }
        await this.executionStore.submitVerification({
          verificationId: verification.id,
          checkerAttemptId: checker.id,
          status: "failed",
          summary: error instanceof Error ? error.message : String(error),
          evidenceIds: [],
        });
      }
    }
  }

  private async proposeKnowledgeWriteback(
    workItem: ExecutionWorkItem,
    checkerAttemptId: string,
    summary?: string,
  ): Promise<void> {
    const requested = workItem.metadata.knowledgeWriteback;
    if (!requested || typeof requested !== "object" || Array.isArray(requested)) return;
    const config = requested as Record<string, unknown>;
    if (typeof config.targetPath !== "string" || !config.targetPath) return;
    const capturedAt = new Date().toISOString();
    const title = typeof config.title === "string" && config.title ? config.title : workItem.title;
    const content = summary?.trim() || `Verified outcome for ${workItem.title}`;
    const memory = await createLocalMemoryProvider(getDefaultDb().db).checkpoint({
      organizationId: this.organizationId,
      kind: "solution",
      title,
      content,
      scope: {
        organizationId: this.organizationId,
        projectId: workItem.projectId,
        goalId: workItem.goalId,
        workItemId: workItem.id,
        agentId: null,
        topic: "verified-work",
      },
      sensitivity: "internal",
      provenance: {
        sourceType: "attempt",
        sourceId: checkerAttemptId,
        capturedAt,
        actorId: null,
        extractor: "worker-checker",
      },
      evidence: [
        {
          kind: "attempt",
          sourceId: checkerAttemptId,
          label: "Independent checker result",
          uri: null,
        },
      ],
      retention: { policy: "long", expiresAt: null },
      status: "active",
      tags: Array.isArray(config.tags)
        ? config.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      relatedIds: [],
      supersedesId: null,
      metadata: { workflowRunId: workItem.workflowRunId },
      phase: "verified",
      sourceType: "attempt",
      sourceId: checkerAttemptId,
      attemptId: checkerAttemptId,
    });
    await new KnowledgeCurator(getDefaultDb().db).createProposal({
      organizationId: this.organizationId,
      title,
      summary: content.slice(0, 4_096),
      content,
      targetPath: config.targetPath,
      knowledgeType: typeof config.knowledgeType === "string" ? config.knowledgeType : "runbook",
      tags: Array.isArray(config.tags)
        ? config.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      sourceMemoryIds: [memory.id],
      factIds: [],
      provenance: {
        sourceType: "memory",
        sourceId: memory.id,
        capturedAt,
        actorId: null,
        extractor: "worker-checker",
      },
      impactSummary: `Reusable knowledge proposed from verified work item ${workItem.id}`,
      status: "proposed",
      reviewedBy: null,
      reviewReason: null,
      reviewedAt: null,
    });
  }

  private async executeDurableAttempt(input: {
    attempt: AgentAttempt;
    workItem: ExecutionWorkItem;
    agentId: string;
    adapter: string;
    prompt: string;
    runtime?: ReturnType<typeof executionTargetSchema.parse>;
    durableSessionId?: string;
    resumeSessionId?: string;
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
    const requestedTools = Array.isArray(input.workItem.metadata.tools)
      ? input.workItem.metadata.tools.filter((tool): tool is string => typeof tool === "string")
      : [];
    const availableTools = new Set(
      profile.tools
        .filter((tool) => tool.allowed && tool.ready)
        .map((tool) => tool.name.toLowerCase()),
    );
    const missingTools = requestedTools.filter((tool) => !availableTools.has(tool.toLowerCase()));
    if (missingTools.length > 0)
      throw new Error(`Assigned agent lacks required tools: ${missingTools.join(", ")}`);
    const requestedSkills = Array.isArray(input.workItem.metadata.skills)
      ? input.workItem.metadata.skills.filter((skill): skill is string => typeof skill === "string")
      : [];
    const availableSkills = new Set(profile.skills.map((skill) => skill.key));
    const missingSkills = requestedSkills.filter((skill) => !availableSkills.has(skill));
    if (missingSkills.length > 0)
      throw new Error(`Assigned agent lacks required skills: ${missingSkills.join(", ")}`);
    const skillRegistry = persistedPlan
      ? null
      : await loadSkillDirectory(process.env.AASPAI_SKILLS_DIR ?? "./skills");
    const repositoryWork = input.workItem.workKind === "repository";
    const repository = repositoryWork
      ? (
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
        )[0]
      : null;
    if (repositoryWork && !repository)
      throw new Error(`Repository ${input.workItem.repositoryId} not found`);
    const workspaceManager = new LocalExecutionWorkspaceManager(
      this.git,
      this.executionStore,
      async (repositoryId) => {
        if (!repository || repositoryId !== repository.id)
          throw new Error("repository scope mismatch");
        return repository.localPath;
      },
    );
    const sourceCommit =
      repository &&
      input.attempt.role === "checker" &&
      ["commit", "pull_request"].includes(input.workItem.deliveryMode)
        ? requiredCheckerCommit(input.workItem)
        : repository &&
            input.workItem.sourceCommitSha &&
            input.workItem.sourceCommitSha !== "0000000"
          ? input.workItem.sourceCommitSha
          : repository
            ? await this.git.resolveCommit(repository.localPath, repository.defaultBranch)
            : (input.workItem.sourceCommitSha ?? "0000000");
    const workspaceRoot = process.env.AASPAI_WORKSPACE_ROOT ?? join("workspace", "worker");
    const workspace = repository
      ? await workspaceManager.prepare({
          organizationId: this.organizationId,
          attemptId: input.attempt.id,
          repositoryId: repository.id,
          repositoryPath: repository.localPath,
          baseCommitSha: sourceCommit,
          workspaceRoot,
          branchName:
            input.attempt.role === "checker"
              ? `checker/${input.attempt.id}`
              : (input.workItem.branchName ?? `worker/${input.attempt.id}`),
        })
      : await workspaceManager.prepareDisposable({
          organizationId: this.organizationId,
          attemptId: input.attempt.id,
          repositoryId: input.workItem.repositoryId,
          baseCommitSha: sourceCommit,
          workspaceRoot,
        });
    const workspacePath = workspace.path;
    const materializedPaths: string[] = [];
    try {
      const scriptedSkills = profile.skills.filter((entry) =>
        entry.skill.files.some((file) => file.kind === "script"),
      );
      if (scriptedSkills.length > 0 && profile.inputs.toolPolicy.allow_skill_scripts !== true) {
        throw new Error(
          `Skill trust review required for executable scripts: ${scriptedSkills
            .map((entry) => `${entry.key}@${entry.version}`)
            .join(", ")}`,
        );
      }
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
      for (const entry of profile.skills) {
        await this.executionStore.recordGovernanceEvent({
          organizationId: this.organizationId,
          workItemId: input.workItem.id,
          attemptId: input.attempt.id,
          action: "skill.materialize",
          decision: "allowed",
          reason: `${entry.key}@${entry.version} content verified`,
          metadata: {
            key: entry.key,
            version: entry.version,
            contentHash: entry.contentHash,
            containsScripts: entry.skill.files.some((file) => file.kind === "script"),
          },
        });
      }
    } catch (error) {
      await (repositoryWork
        ? workspaceManager.release(workspace.id)
        : workspaceManager.releaseDisposable(workspace.id)
      ).catch(() => undefined);
      throw error;
    }
    const mayManageCompany =
      input.attempt.role === "maker" &&
      (await this.isAuthorizedManager(input.agentId, input.workItem.projectId));
    const mayUseBrowser =
      input.adapter === "opencode_cli" &&
      profile.tools.some(
        (decision) =>
          decision.name.toLowerCase() === "browser_snapshot" && decision.allowed && decision.ready,
      );
    const adapterConfig = {
      ...profile.inputs.adapterConfig,
      ...(input.adapter === "opencode_cli" &&
      profile.skills.length > 0 &&
      !Array.isArray(profile.inputs.adapterConfig.skillsPaths)
        ? { skillsPaths: [".opencode_cli/skills"] }
        : {}),
      ...(input.adapter === "opencode_cli" && (mayManageCompany || mayUseBrowser)
        ? { xdgConfigHome: ".opencode_cli" }
        : {}),
    };
    if (input.adapter === "opencode_cli" && mayManageCompany) {
      const companyActionTool = join(
        workspacePath,
        ".opencode_cli",
        "opencode",
        "tools",
        "company_action.ts",
      );
      await mkdir(dirname(companyActionTool), { recursive: true });
      await writeFile(companyActionTool, COMPANY_ACTION_TOOL_SOURCE, "utf8");
      materializedPaths.push(companyActionTool);
    }
    if (mayUseBrowser) {
      const browserTool = join(
        workspacePath,
        ".opencode_cli",
        "opencode",
        "tools",
        "browser_snapshot.ts",
      );
      await mkdir(dirname(browserTool), { recursive: true });
      await writeFile(browserTool, BROWSER_SNAPSHOT_TOOL_SOURCE, "utf8");
      materializedPaths.push(browserTool);
    }
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
            branchName: workspace.branchName,
            capturedAt: new Date().toISOString(),
          },
          target: {
            ...(input.runtime ?? profile.runtime.target),
            ...((input.runtime ?? profile.runtime.target).kind === "local"
              ? { cwd: workspacePath }
              : {}),
          },
          harness: input.adapter,
          agentId: input.agentId,
          idempotencyKey: input.attempt.id,
          prompt: input.prompt,
          harnessConfig: adapterConfig,
          runtimeConfig: { workspacePolicy: "disposable" },
          profile,
        }));
      assertGovernedRuntimeIsolation(plan.harness, plan.target, true);

      const runController = new AbortController();
      let checkingCancellation = false;
      const checkCancellation = async () => {
        if (checkingCancellation || runController.signal.aborted) return;
        checkingCancellation = true;
        try {
          const current = await this.executionStore.getAttempt(input.attempt.id);
          if (current?.status === "cancelling" || current?.cancelRequestedAt) runController.abort();
        } finally {
          checkingCancellation = false;
        }
      };
      await checkCancellation();
      const cancellationPoll = setInterval(() => void checkCancellation(), 1_000);
      cancellationPoll.unref();
      let result: AdapterExecutionResult;
      try {
        result = await new HarnessExecutionPlanRunner(this.executionStore).run({
          plan,
          workspace: { ...workspace, status: "ready" },
          profile,
          durableSessionId: input.durableSessionId,
          resumeSessionId: input.resumeSessionId,
          signal: runController.signal,
          onExecuted: async (result) => {
            await Promise.all(
              materializedPaths.map((path) => rm(path, { recursive: true, force: true })),
            );
            await this.persistAttemptOutput({
              result,
              attempt: input.attempt,
              workItem: input.workItem,
              workspacePath,
              sourceCommit,
              branchName: workspace.branchName,
              repositoryWork,
            });
            if (mayManageCompany && !result.timedOut && result.exitCode === 0) {
              const actions = companyActions(result);
              const missingActions = missingRequiredCompanyActions(
                input.workItem.metadata.requiredCompanyActions,
                actions,
              );
              if (missingActions.length > 0)
                throw new Error(
                  `Manager run omitted required company actions: ${missingActions
                    .map(
                      (action) => `${action.type}${action.projectId ? `:${action.projectId}` : ""}`,
                    )
                    .join(", ")}`,
                );
              await this.applyCompanyActions(actions, {
                attempt: input.attempt,
                workItem: input.workItem,
                managerAgentId: input.agentId,
              });
            }
          },
        });
      } finally {
        clearInterval(cancellationPoll);
      }
      await this.recordGeneralWorkEvidence(result, input.attempt, input.workItem);
      return result;
    } finally {
      await (repositoryWork
        ? workspaceManager.release(workspace.id)
        : workspaceManager.releaseDisposable(workspace.id)
      ).catch(() => undefined);
    }
  }

  private async recordGeneralWorkEvidence(
    result: AdapterExecutionResult,
    attempt: AgentAttempt,
    workItem: ExecutionWorkItem,
  ): Promise<void> {
    if (
      attempt.role !== "maker" ||
      workItem.workKind !== "general" ||
      !workItem.workflowRunId ||
      result.timedOut ||
      result.exitCode !== 0
    ) {
      return;
    }
    const text =
      typeof result.resultJson?.text === "string" ? result.resultJson.text : result.summary;
    if (!text?.trim()) throw new Error("Successful general work produced no report");
    await this.executionStore.createLoopOutput({
      organizationId: this.organizationId,
      loopId: "company/runtime",
      workflowRunId: workItem.workflowRunId,
      kind: "report",
      sourceRef: attempt.id,
      title: `Work result: ${workItem.title}`.slice(0, 512),
      body: text.trim().slice(0, 65_536),
      severity: "info",
      workItemId: workItem.id,
    });
  }

  private async applyCompanyActions(
    actions: CompanyAction[],
    input: {
      attempt: AgentAttempt;
      workItem: ExecutionWorkItem;
      managerAgentId: string;
    },
  ): Promise<void> {
    if (actions.length === 0) return;
    if (!(await this.isAuthorizedManager(input.managerAgentId, input.workItem.projectId))) {
      throw new Error(`${input.managerAgentId} is not authorized to hire for this project`);
    }
    const manager = await this.agentSource.get(input.managerAgentId);
    const operations = new CompanyOperationsService(getDefaultDb().db);
    const control = new CompanyControlPlaneService(getDefaultDb().db, this.executionStore);
    const commands = new CompanyCommandService(getDefaultDb().db);
    const [companyProfile] = await getDefaultDb()
      .db.select({ ceoAgentId: companyProfiles.ceoAgentId })
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, this.organizationId))
      .limit(1);
    const isCeo = input.managerAgentId === companyProfile?.ceoAgentId;
    const createdMilestones = new Map<string, string>();

    let activeAction: { action: CompanyAction; actionIndex: number; projectId: string } | null =
      null;
    try {
      for (const [actionIndex, action] of actions.entries()) {
        const targetProjectId = action.projectId ?? input.workItem.projectId;
        if (!targetProjectId) throw new Error("Company action has no project");
        activeAction = { action, actionIndex, projectId: targetProjectId };
        await this.recordCompanyAction(
          input.attempt.id,
          action,
          actionIndex,
          targetProjectId,
          "started",
        );
        if (!isCeo && targetProjectId !== input.workItem.projectId)
          throw new Error("A manager may only hire within their assigned project");
        const [targetProject] = await getDefaultDb()
          .db.select({ id: projects.id, goalId: projects.goalId })
          .from(projects)
          .where(
            and(eq(projects.organizationId, this.organizationId), eq(projects.id, targetProjectId)),
          )
          .limit(1);
        if (!targetProject) throw new Error(`Project ${targetProjectId} not found`);
        if (action.type === "create_milestone") {
          const created = await commands.execute({
            type: "create_milestone",
            organizationId: this.organizationId,
            actorId: input.managerAgentId,
            idempotencyKey: `manager-action:${input.workItem.id}:milestone:${actionIndex}`,
            projectId: targetProject.id,
            title: action.title,
            outcome: action.outcome,
            sequence: action.sequence,
            acceptance: action.acceptance,
            ownerAgentId: input.managerAgentId,
          });
          if (created.id) createdMilestones.set(targetProject.id, created.id);
          await this.recordCompanyAction(
            input.attempt.id,
            action,
            actionIndex,
            targetProject.id,
            "succeeded",
            { milestoneId: created.id ?? null },
          );
          activeAction = null;
          continue;
        }
        if (action.type === "define_and_start_process") {
          if (!input.workItem.definitionRevisionId)
            throw new Error("Process action requires a pinned definition revision");
          const milestoneId =
            action.milestoneSequence === undefined
              ? createdMilestones.get(targetProject.id)
              : (
                  await getDefaultDb()
                    .db.select({ id: milestones.id })
                    .from(milestones)
                    .where(
                      and(
                        eq(milestones.organizationId, this.organizationId),
                        eq(milestones.projectId, targetProject.id),
                        eq(milestones.sequence, action.milestoneSequence),
                      ),
                    )
                    .limit(1)
                )[0]?.id;
          if (!milestoneId)
            throw new Error("Process action must reference a milestone created for the project");
          const binding = await commands.execute({
            type: "bind_process",
            organizationId: this.organizationId,
            actorId: input.managerAgentId,
            idempotencyKey: `manager-action:${input.workItem.id}:bind:${actionIndex}`,
            projectId: targetProject.id,
            processDefinitionId: action.definition.id,
            processRevision: action.definition.revision,
            definition: action.definition,
            ownerAgentId: input.managerAgentId,
            loopId: action.loopId ?? null,
            policy: action.policy ?? {},
          });
          const processRun = await commands.execute({
            type: "start_process_run",
            organizationId: this.organizationId,
            actorId: input.managerAgentId,
            idempotencyKey: `manager-action:${input.workItem.id}:run:${actionIndex}`,
            projectId: targetProject.id,
            goalId: targetProject.goalId,
            milestoneId,
            repositoryId: input.workItem.repositoryId,
            definitionRevisionId: input.workItem.definitionRevisionId,
            operatorAgentId: input.managerAgentId,
            sourceCommitSha: input.workItem.sourceCommitSha,
            definition: action.definition,
          });
          await this.recordCompanyAction(
            input.attempt.id,
            action,
            actionIndex,
            targetProject.id,
            "succeeded",
            { processBindingId: binding.id ?? null, processRunId: processRun.id ?? null },
          );
          activeAction = null;
          continue;
        }
        const definition = await this.writeHiredAgent(action, manager);
        await operations.registerServiceAgent({
          organizationId: this.organizationId,
          agentId: action.agentId,
          metadata: {
            roles: [action.role],
            capabilities: [action.role],
            definitionManaged: true,
            hiredBy: input.managerAgentId,
          },
        });
        if (action.projectRole === "manager") {
          if (!isCeo) throw new Error("Only the CEO may appoint a project manager");
          await commands.execute({
            type: "appoint_project_manager",
            organizationId: this.organizationId,
            actorId: input.managerAgentId,
            idempotencyKey: `manager-action:${input.workItem.id}:${action.agentId}:assignment`,
            projectId: targetProject.id,
            agentId: action.agentId,
          });
        } else {
          await commands.execute({
            type: "assign_agent_to_project",
            organizationId: this.organizationId,
            actorId: input.managerAgentId,
            idempotencyKey: `manager-action:${input.workItem.id}:${action.agentId}:assignment`,
            projectId: targetProject.id,
            agentId: action.agentId,
            role: "member",
            allocationPercent: 100,
          });
        }
        await control.setAuthorityEdge({
          organizationId: this.organizationId,
          fromAgentId: input.managerAgentId,
          toAgentId: action.agentId,
          relation: "may_delegate_to",
        });
        const definitionRevision = await this.executionStore.createDefinitionRevision({
          organizationId: this.organizationId,
          repositoryId: input.workItem.repositoryId,
          commitSha: input.workItem.sourceCommitSha ?? "0000000",
          sourcePath: definition.sourcePath,
          dirty: true,
          contentHash: definition.contentHash,
        });
        const delegatedWorkflow = await this.executionStore.createWorkflowRun({
          organizationId: this.organizationId,
          goalId: targetProject.goalId,
          definitionRevisionId: definitionRevision.id,
          sourceType: "manager_delegation",
          sourceId: input.workItem.id,
          idempotencyKey: `manager-action:${input.workItem.id}:${action.agentId}:workflow`,
        });
        const delegation = await control.delegate({
          organizationId: this.organizationId,
          idempotencyKey: `manager-action:${input.workItem.id}:${action.agentId}`,
          requestedByAgentId: input.managerAgentId,
          targetAgentId: action.agentId,
          departmentId: null,
          requiredRole: action.role,
          capability: null,
          risk: "low",
          priority: Math.min(100, input.workItem.priority + 1),
          title: action.workTitle,
          description: action.workDescription,
          goalId: targetProject.goalId,
          projectId: targetProject.id,
          repositoryId: input.workItem.repositoryId,
          workflowRunId: delegatedWorkflow.id,
          milestoneId: input.workItem.milestoneId,
          processBindingId: input.workItem.processBindingId,
          parentWorkItemId: input.workItem.id,
          definitionRevisionId: definitionRevision.id,
          sourceCommitSha: input.workItem.sourceCommitSha,
          maxAttempts: Math.max(3, input.workItem.maxAttempts),
          workKind: "general",
          deliveryMode: "none",
          metadata: {
            ...(action.artifactPaths
              ? {
                  declaredArtifacts: action.artifactPaths.map((path) => ({
                    path,
                    kind: "other",
                  })),
                }
              : {}),
            evidencePolicy: {
              citationPaths: action.citationPaths ?? [],
              commercialClaimPaths: action.commercialClaimPaths ?? [],
              scanAllArtifacts: true,
            },
            ...(action.projectRole === "manager"
              ? {
                  requiredCompanyActions: [
                    { type: "create_milestone", projectId: targetProject.id },
                    { type: "define_and_start_process", projectId: targetProject.id },
                  ],
                }
              : {}),
          },
        });
        if (!delegation.workItemId) throw new Error(`Delegation ${delegation.id} has no work item`);
        const delegated = await this.executionStore.getWorkItem(delegation.workItemId);
        if (!delegated) throw new Error(`Delegated work ${delegation.workItemId} disappeared`);
        await this.queueDelegatedWork(action, delegated, manager.adapter, input.managerAgentId);
        await this.executionStore.recordGovernanceEvent({
          organizationId: this.organizationId,
          workItemId: input.workItem.id,
          attemptId: input.attempt.id,
          action: "agent.hire_and_delegate",
          decision: "allowed",
          reason: `${action.title} hired and assigned ${delegated.id}`,
          metadata: {
            agentId: action.agentId,
            delegationId: delegation.id,
            delegatedWorkItemId: delegated.id,
          },
        });
        await this.recordCompanyAction(
          input.attempt.id,
          action,
          actionIndex,
          targetProject.id,
          "succeeded",
          {
            agentId: action.agentId,
            delegationId: delegation.id,
            delegatedWorkItemId: delegated.id,
          },
        );
        activeAction = null;
      }
    } catch (error) {
      if (activeAction) {
        await this.recordCompanyAction(
          input.attempt.id,
          activeAction.action,
          activeAction.actionIndex,
          activeAction.projectId,
          "failed",
          { error: error instanceof Error ? error.message : String(error) },
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  private async recordCompanyAction(
    attemptId: string,
    action: CompanyAction,
    actionIndex: number,
    projectId: string,
    status: "started" | "succeeded" | "failed",
    outcome: Record<string, unknown> = {},
  ): Promise<void> {
    await this.executionStore.appendNextEvent({
      organizationId: this.organizationId,
      attemptId,
      type: `company.action.${status}`,
      payload: {
        plane: "company",
        origin: "aaspai",
        tool: "company_action",
        actionType: action.type,
        actionIndex,
        projectId,
        status,
        expectedEffects: COMPANY_TOOL_CATALOG[action.type].effects,
        ...outcome,
      },
    });
  }

  private async writeHiredAgent(
    action: HireAndDelegateAction,
    manager: Readonly<AgentConfig>,
  ): Promise<{ sourcePath: string; contentHash: string }> {
    const slug = action.agentId.slice("agent/".length);
    const root = resolve(process.env.AASPAI_AGENTS_DIR ?? DEFAULT_AGENTS_DIR);
    const directory = resolve(root, slug);
    if (await this.agentSource.has(action.agentId)) {
      const existing = await this.agentSource.get(action.agentId);
      if (existing.title !== action.title || existing.role !== action.role) {
        throw new Error(`Agent ${action.agentId} already exists with a different profile`);
      }
      return {
        sourcePath: `agents/${slug}`,
        contentHash: await hashAgentDefinition(directory),
      };
    }
    const scoped = relative(root, directory);
    if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) {
      throw new Error(`Unsafe hired-agent path for ${action.agentId}`);
    }
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "config.yaml"),
      `${JSON.stringify(
        {
          adapterConfig: manager.adapterConfig,
          runtimeConfig: manager.runtimeConfig,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(directory, "tools.yaml"),
      `${JSON.stringify(hiredAgentTools(manager.tools, action.role), null, 2)}\n`,
      "utf8",
    );
    const requestedSkills = new Set(action.skillKeys ?? []);
    const skills = manager.skills.filter(
      (skill) =>
        skill &&
        typeof skill === "object" &&
        "key" in skill &&
        requestedSkills.has(String(skill.key)),
    );
    if (skills.length !== requestedSkills.size) {
      throw new Error("Hired agent requested a skill not approved for the manager");
    }
    await writeFile(
      join(directory, "skills.lock.json"),
      `${JSON.stringify(skills, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(directory, "relations.yaml"),
      `reportsTo: ${manager.id}\nmanages: []\npeers: []\n`,
      "utf8",
    );
    const agentDefinition = join(directory, "AGENT.md");
    const pendingDefinition = `${agentDefinition}.tmp`;
    await writeFile(
      pendingDefinition,
      `---
id: ${action.agentId}
type: Agent
title: ${JSON.stringify(action.title)}
description: ${JSON.stringify(action.description)}
timestamp: ${new Date().toISOString()}
adapter: ${manager.adapter}
${manager.model ? `model: ${JSON.stringify(manager.model)}\n` : ""}role: ${action.role}
reportsTo: ${manager.id}
manages: []
peers: []
tools:
  allow: []
  deny: []
  require_approval_for: []
skills: []
knowledge:
  include: ["**"]
  exclude: []
runtime:
  default: { kind: local }
---

# ${action.title}

${action.description}

Complete assigned work with concrete evidence. Report what you did, what remains uncertain, and the next action.

Use typed actions instead of merely describing company changes. In OpenCode call company_action. In Codex return the exact final line AASPAI_COMPANY_ACTIONS={"actions":[...]}. Project managers establish measurable outcomes with create_milestone, hire only immediately needed specialists with hire_and_delegate, and create the smallest repeatable operating loop with define_and_start_process.
`,
      "utf8",
    );
    await rename(pendingDefinition, agentDefinition);

    const manages = [...new Set([...manager.manages, action.agentId])];
    const managerSlug = manager.id.slice("agent/".length);
    await writeFile(
      join(root, managerSlug, "relations.yaml"),
      `reportsTo: ${manager.reportsTo ?? "null"}\nmanages:\n${manages
        .map((id) => `  - ${id}`)
        .join("\n")}\npeers: []\n`,
      "utf8",
    );
    return {
      sourcePath: `agents/${slug}`,
      contentHash: await hashAgentDefinition(directory),
    };
  }

  private async queueDelegatedWork(
    action: HireAndDelegateAction,
    workItem: ExecutionWorkItem,
    adapter: string,
    managerAgentId: string,
  ): Promise<void> {
    if (!workItem.workflowRunId) throw new Error("Delegated work has no workflow run");
    const suffix = createHash("sha256")
      .update(`${workItem.id}\0${action.agentId}`)
      .digest("hex")
      .slice(0, 32);
    const sessionId = `sess_${suffix}`;
    const wakeupId = `wake_${suffix}`;
    const requestedAt = new Date().toISOString();
    const prompt = `${action.workDescription}\n\nAssignment: ${action.workTitle}\n\nReturn concrete evidence and the next action.`;
    getDefaultDb().db.transaction((tx) => {
      tx.insert(wakeupsTable)
        .values({
          id: wakeupId,
          organizationId: this.organizationId,
          loopId: "manual",
          source: "agent",
          triggerDetail: "manager-delegation",
          reason: `Delegated by ${managerAgentId} to ${action.agentId}`,
          agentId: action.agentId,
          payloadJson: JSON.stringify({
            prompt,
            adapter,
            sessionId,
            workItemId: workItem.id,
            workflowRunId: workItem.workflowRunId,
            traceId: sessionId,
          }),
          status: "queued",
          idempotencyKey: `delegated-run:${workItem.id}`,
          requestedAt,
          requestedByActorId: managerAgentId,
          requestedByActorType: "agent",
        } as never)
        .onConflictDoNothing()
        .run();
      tx.insert(sessionsTable)
        .values({
          id: sessionId,
          organizationId: this.organizationId,
          wakeupId,
          agentId: action.agentId,
          adapter,
          runtimeJson: "{}",
          prompt,
          configJson: "{}",
          status: "queued",
        })
        .onConflictDoNothing()
        .run();
    });
  }

  private async isAuthorizedManager(agentId: string, projectId: string | null) {
    const [profile] = await getDefaultDb()
      .db.select({ ceoAgentId: companyProfiles.ceoAgentId })
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, this.organizationId))
      .limit(1);
    if (agentId === profile?.ceoAgentId) return true;
    if (!projectId) return false;
    const [assignment] = await getDefaultDb()
      .db.select({ id: projectAssignments.id })
      .from(projectAssignments)
      .where(
        and(
          eq(projectAssignments.organizationId, this.organizationId),
          eq(projectAssignments.projectId, projectId),
          eq(projectAssignments.agentId, agentId),
          eq(projectAssignments.role, "manager"),
          eq(projectAssignments.status, "active"),
        ),
      )
      .limit(1);
    return Boolean(assignment);
  }

  private async persistAttemptOutput(input: {
    result: AdapterExecutionResult;
    attempt: AgentAttempt;
    workItem: ExecutionWorkItem;
    workspacePath: string;
    sourceCommit: string;
    branchName: string;
    repositoryWork: boolean;
  }): Promise<void> {
    const successful = input.result.exitCode === 0 && !input.result.timedOut;
    let artifactDeclarations = declaredArtifacts(input.workItem.metadata);
    if (
      !input.repositoryWork &&
      input.attempt.role === "maker" &&
      artifactDeclarations.length === 0
    ) {
      const outputPaths = await listWorkspaceFiles(input.workspacePath);
      if (outputPaths.length > 32) {
        throw new Error("General work produced more than 32 artifact files");
      }
      artifactDeclarations = outputPaths.map((path) => ({
        path,
        kind: "other",
        mediaType: outputMediaType(path),
      }));
    }
    const changedPaths = input.repositoryWork
      ? changedPathsFromStatus((await this.git.status(input.workspacePath)).entries)
      : input.attempt.role === "checker"
        ? await listWorkspaceFiles(input.workspacePath)
        : artifactDeclarations.map((artifact) => artifact.path);
    if (input.attempt.role === "checker" && changedPaths.length > 0)
      throw new Error(`checker modified files: ${changedPaths.join(", ")}`);
    const policyDecision = evaluateExecutionPolicy(input.workItem.governance, {
      ...input.workItem.metadata,
      paths: changedPaths,
    });
    if (!policyDecision.ok) {
      await this.executionStore.recordGovernanceEvent({
        organizationId: this.organizationId,
        workItemId: input.workItem.id,
        attemptId: input.attempt.id,
        action: "post_run_diff",
        decision: "denied",
        reason: policyDecision.reason,
        metadata: { paths: changedPaths },
      });
      throw new Error(`post-run policy denied changes: ${policyDecision.reason}`);
    }
    if (successful && input.attempt.role === "maker") {
      await validateEvidencePolicy(
        input.workspacePath,
        input.workItem.metadata,
        artifactDeclarations.map((artifact) => artifact.path),
      );
    }
    const commit =
      successful &&
      input.attempt.role === "maker" &&
      input.repositoryWork &&
      ["commit", "pull_request"].includes(input.workItem.deliveryMode)
        ? await this.git.commit(input.workspacePath, `aaspai attempt ${input.attempt.id}`)
        : null;
    if (
      successful &&
      input.attempt.role === "maker" &&
      input.repositoryWork &&
      ["commit", "pull_request"].includes(input.workItem.deliveryMode) &&
      !commit
    ) {
      throw new Error(`${input.workItem.deliveryMode} delivery produced no commit`);
    }
    if (
      successful &&
      input.attempt.role === "maker" &&
      input.workItem.deliveryMode === "artifact" &&
      artifactDeclarations.length === 0
    ) {
      throw new Error("artifact delivery requires metadata.declaredArtifacts");
    }
    const patch = input.repositoryWork
      ? await this.git.diff(input.workspacePath, input.sourceCommit, commit ?? undefined)
      : "";
    const attemptRoot = resolve(
      process.env.AASPAI_ARTIFACTS_ROOT ?? join(".aaspai", "artifacts"),
      input.attempt.id,
    );
    await mkdir(attemptRoot, { recursive: true });
    const resultPath = join(attemptRoot, "result.json");
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          exitCode: input.result.exitCode,
          timedOut: input.result.timedOut,
          summary: input.result.summary ?? null,
          resultJson: input.result.resultJson ?? null,
          errorMessage: input.result.errorMessage ?? null,
          usage: input.result.usage ?? null,
          costUsd: input.result.costUsd ?? null,
        },
        null,
        2,
      ),
      "utf8",
    );
    await this.recordArtifact(input.attempt.id, "result", resultPath, "application/json");
    if (patch) {
      const patchPath = join(attemptRoot, "changes.patch");
      await writeFile(patchPath, patch, "utf8");
      await this.recordArtifact(input.attempt.id, "patch", patchPath, "text/x-diff");
    }

    const workspaceRoot = await realpath(input.workspacePath);
    let artifactBytes = 0;
    for (const declaration of artifactDeclarations) {
      if (isAbsolute(declaration.path)) throw new Error("Declared artifact path must be relative");
      const source = await realpath(resolve(workspaceRoot, declaration.path));
      const safePath = relative(workspaceRoot, source);
      if (!safePath || safePath.startsWith("..") || isAbsolute(safePath)) {
        throw new Error(`Declared artifact escapes the workspace: ${declaration.path}`);
      }
      const sourceStat = await stat(source);
      if (!sourceStat.isFile()) {
        throw new Error(`Declared artifact is not a file: ${declaration.path}`);
      }
      if (sourceStat.size > 16 * 1024 * 1024) {
        throw new Error(`Declared artifact exceeds 16 MiB: ${declaration.path}`);
      }
      artifactBytes += sourceStat.size;
      if (artifactBytes > 64 * 1024 * 1024) {
        throw new Error("Declared artifacts exceed 64 MiB total");
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
    if (commit) {
      await this.executionStore.recordDeliveryCommit(
        input.workItem.id,
        input.attempt.id,
        commit,
        input.branchName,
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
        projectId: null,
        purpose: "blueprint",
        provider: "local",
        localPath: process.env.AASPAI_DEFINITIONS_DIR ?? ".",
        defaultBranch: "main",
      });
    } else if (repository[0].projectId !== null) {
      await handle.db
        .update(repositories)
        .set({ projectId: null, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(repositories.organizationId, this.organizationId),
            eq(repositories.id, repositoryId),
          ),
        )
        .run();
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
    const lostAttempts = await new ExecutionStore(handle.db).reconcileLostAttempts(
      cutoff,
      this.organizationId,
    );
    if (lostAttempts > 0) log.warn("reconciled lost execution attempts", { lostAttempts, staleMs });
    const stale = await handle.db
      .select()
      .from(wakeupsTable)
      .where(
        and(
          eq(wakeupsTable.organizationId, this.organizationId),
          eq(wakeupsTable.status, "claimed"),
        ),
      );

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
