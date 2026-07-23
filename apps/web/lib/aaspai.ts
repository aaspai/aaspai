/**
 * Server-side data access for aaspai.
 *
 * The web app reads the user's aaspai project from the current
 * working directory (or `AASPAI_CWD` env var). The same source
 * files (`agents/`, `knowledge/`, `loops/`) and the same
 * `.aaspai/state.db` are read by the CLI and worker.
 *
 * In v0, the web app runs in the same workspace as the CLI. The
 * workspace is identified by either:
 *   1. `process.cwd()` when the dev server was started there, or
 *   2. `AASPAI_CWD` env var (set in production by the orchestrator).
 *
 * In v1 (SaaS), this becomes a multi-tenant abstraction:
 * `getWorkspaceForUser(userId)` reads from a registry of
 * workspace roots, indexed by org.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  agentAttempts,
  artifacts,
  definitionRevisions,
  executionEvents,
  executionPlans,
  executionWorkItems,
  executionWorkspaces,
  getDefaultDb,
  goals,
  projects,
  repositories,
  sessionEvents,
  sessions,
  wakeups,
} from "@aaspai/db";
import { FileAgentConfigSource } from "@aaspai/file-loader";
import { asc, desc, eq } from "drizzle-orm";

/**
 * Resolve the workspace root and pin `AASPAI_CWD` + `AASPAI_DB` so
 * that downstream consumers (db, sessions, file-loader) open files
 * relative to the workspace, not to the dev server's `process.cwd()`.
 *
 * Idempotent — safe to call from any data accessor.
 */
function ensureWorkspaceEnv(): void {
  const root = workspaceRoot();
  process.env.AASPAI_CWD = root;
  if (!process.env.AASPAI_DB) {
    process.env.AASPAI_DB = `sqlite:${join(root, ".aaspai", "state.db")}`;
  }
}

export function workspaceRoot(): string {
  const fromEnv = process.env.AASPAI_CWD;
  if (fromEnv) return resolve(fromEnv);
  return process.cwd();
}

export function isAaspaiWorkspace(): boolean {
  const root = workspaceRoot();
  return (
    existsSync(join(root, "aaspai.config.ts")) ||
    existsSync(join(root, "aaspai.config.json")) ||
    existsSync(join(root, ".aaspai", "state.db"))
  );
}

export interface AgentSummary {
  id: string;
  title: string;
  role: string;
  adapter: string;
  model: string | null;
  reportsTo: string | null;
  manages: string[];
  peers: string[];
}

export interface SessionSummary {
  id: string;
  status: string;
  agentId: string;
  adapter: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
}

export interface StateSnapshot {
  ok: boolean;
  workspace: string;
  counts: {
    agents: number;
    sessions: number;
    wakeups: { queued: number; running: number; failed: number; completed: number };
  };
  recentSessions: SessionSummary[];
  recentWakeups: Array<{ id: string; status: string; reason: string | null; loopId: string }>;
}

let agentSourceCache: FileAgentConfigSource | null = null;
let agentSourceCacheKey: string | null = null;

function agentSource(): FileAgentConfigSource {
  const root = workspaceRoot();
  if (agentSourceCache && agentSourceCacheKey === root) return agentSourceCache;
  agentSourceCache?.stop();
  const src = new FileAgentConfigSource(join(root, "agents"));
  agentSourceCache = src;
  agentSourceCacheKey = root;
  return src;
}

export async function listAgents(): Promise<AgentSummary[]> {
  ensureWorkspaceEnv();
  const src = agentSource();
  await src.start();
  const ids = await src.list();
  const out: AgentSummary[] = [];
  for (const id of ids) {
    try {
      const cfg = await src.get(id);
      out.push({
        id: cfg.id,
        title: cfg.title,
        role: cfg.role,
        adapter: cfg.adapter,
        model: cfg.model ?? null,
        reportsTo: cfg.reportsTo ?? null,
        manages: cfg.manages,
        peers: cfg.peers,
      });
    } catch {
      // skip invalid agents
    }
  }
  return out;
}

export async function getAgent(id: string): Promise<AgentSummary | null> {
  ensureWorkspaceEnv();
  const src = agentSource();
  await src.start();
  try {
    const cfg = await src.get(id);
    return {
      id: cfg.id,
      title: cfg.title,
      role: cfg.role,
      adapter: cfg.adapter,
      model: cfg.model ?? null,
      reportsTo: cfg.reportsTo ?? null,
      manages: cfg.manages,
      peers: cfg.peers,
    };
  } catch {
    return null;
  }
}

export async function getAgentSystemPrompt(id: string): Promise<string | null> {
  ensureWorkspaceEnv();
  const src = agentSource();
  await src.start();
  try {
    const cfg = await src.get(id);
    return cfg.systemPrompt || null;
  } catch {
    return null;
  }
}

export async function getAgentHierarchy(): Promise<{
  agents: AgentSummary[];
  roots: string[];
}> {
  ensureWorkspaceEnv();
  const agents = await listAgents();
  const reportsToMap = new Map<string, string | null>();
  for (const a of agents) reportsToMap.set(a.id, a.reportsTo);

  const childrenMap = new Map<string, string[]>();
  for (const a of agents) {
    if (a.reportsTo) {
      const list = childrenMap.get(a.reportsTo) ?? [];
      list.push(a.id);
      childrenMap.set(a.reportsTo, list);
    }
  }

  const roots = agents.filter((a) => !a.reportsTo).map((a) => a.id);
  return { agents, roots };
}

export async function listRecentSessions(limit = 20): Promise<SessionSummary[]> {
  ensureWorkspaceEnv();
  if (!isAaspaiWorkspace()) return [];
  const handle = getDefaultDb();
  try {
    const rows = await handle.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.startedAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      status: r.status ?? "unknown",
      agentId: r.agentId,
      adapter: r.adapter,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      errorMessage: r.errorMessage,
    }));
  } finally {
    // Don't close here — server may reuse the connection.
  }
}

export async function getSession(id: string): Promise<SessionSummary | null> {
  ensureWorkspaceEnv();
  if (!isAaspaiWorkspace()) return null;
  const handle = getDefaultDb();
  const rows = await handle.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status ?? "unknown",
    agentId: r.agentId,
    adapter: r.adapter,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    errorMessage: r.errorMessage,
  };
}

export async function getStateSnapshot(): Promise<StateSnapshot> {
  ensureWorkspaceEnv();
  const root = workspaceRoot();
  if (!isAaspaiWorkspace()) {
    return {
      ok: false,
      workspace: root,
      counts: {
        agents: 0,
        sessions: 0,
        wakeups: { queued: 0, running: 0, failed: 0, completed: 0 },
      },
      recentSessions: [],
      recentWakeups: [],
    };
  }
  const handle = getDefaultDb();
  const agents = await listAgents();
  const recentSessions = await listRecentSessions(10);

  // Group sessions by status for the counts
  const sessionRows = await handle.db.select({ status: sessions.status }).from(sessions);
  const sessionCounts = { queued: 0, running: 0, failed: 0, completed: 0 };
  for (const r of sessionRows) {
    const s = r.status ?? "unknown";
    if (s === "queued") sessionCounts.queued++;
    else if (s === "running") sessionCounts.running++;
    else if (s === "failed") sessionCounts.failed++;
    else if (s === "succeeded" || s === "completed") sessionCounts.completed++;
  }

  const wakeupRows = await handle.db
    .select({
      id: wakeups.id,
      status: wakeups.status,
      reason: wakeups.reason,
      loopId: wakeups.loopId,
    })
    .from(wakeups)
    .orderBy(desc(wakeups.requestedAt))
    .limit(10);
  const wakeupCounts = { queued: 0, running: 0, failed: 0, completed: 0 };
  for (const w of sessionRows) {
    const s = w.status ?? "unknown";
    if (s === "queued") wakeupCounts.queued++;
    else if (s === "running") wakeupCounts.running++;
    else if (s === "failed") wakeupCounts.failed++;
    else if (s === "succeeded" || s === "completed") wakeupCounts.completed++;
  }

  return {
    ok: true,
    workspace: root,
    counts: {
      agents: agents.length,
      sessions: sessionRows.length,
      wakeups: wakeupCounts,
    },
    recentSessions,
    recentWakeups: wakeupRows.map((r) => ({
      id: r.id,
      status: r.status ?? "unknown",
      reason: r.reason,
      loopId: r.loopId,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Session detail
// ─────────────────────────────────────────────────────────────────────

export type TranscriptKind =
  | "init"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "result"
  | "system"
  | "stdout"
  | "stderr"
  | "unknown";

export interface TranscriptEntry {
  /** sequence number within the session (1, 2, 3, …) */
  seq: number;
  kind: TranscriptKind;
  ts: string;
  /** raw payload parsed from session_events.payload_json */
  payload: Record<string, unknown>;
}

export interface SessionDetail extends SessionSummary {
  prompt: string;
  config: Record<string, unknown>;
  runtime: Record<string, unknown>;
  sessionParams: Record<string, unknown>;
  result: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  parentSessionId: string | null;
  wakeupId: string | null;
  /** Ordered list of every event recorded during the run. */
  transcript: TranscriptEntry[];
  /** All wakeup fields (for the wakeup that triggered this session). */
  wakeup: {
    id: string;
    status: string;
    reason: string | null;
    source: string | null;
    loopId: string;
    requestedAt: string;
    finishedAt: string | null;
    error: string | null;
  } | null;
}

function safeJson(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const parsed = JSON.parse(s) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function getSessionDetail(id: string): Promise<SessionDetail | null> {
  ensureWorkspaceEnv();
  if (!isAaspaiWorkspace()) return null;
  const handle = getDefaultDb();
  const rows = await handle.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  const s = rows[0];
  if (!s) return null;

  // Pull the full event transcript (ordered by sequence number).
  const events = await handle.db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, id))
    .orderBy(asc(sessionEvents.seq));
  const transcript: TranscriptEntry[] = events.map((e) => {
    const payload = safeJson(e.payloadJson) ?? {};
    const kind = (
      typeof payload.kind === "string" ? (payload.kind as string) : e.kind
    ) as TranscriptKind;
    return {
      seq: e.seq,
      kind,
      ts: e.ts,
      payload,
    };
  });

  // Pull the wakeup that triggered this session, if any.
  let wakeup: SessionDetail["wakeup"] = null;
  if (s.wakeupId && s.wakeupId !== "manual") {
    const wRows = await handle.db.select().from(wakeups).where(eq(wakeups.id, s.wakeupId)).limit(1);
    const w = wRows[0];
    if (w) {
      wakeup = {
        id: w.id,
        status: w.status ?? "unknown",
        reason: w.reason,
        source: w.source,
        loopId: w.loopId,
        requestedAt: w.requestedAt,
        finishedAt: w.finishedAt,
        error: w.error,
      };
    }
  }

  const result = safeJson(s.resultJson);
  const resultSessionParams = result?.sessionParams;
  const sessionParams =
    safeJson(s.sessionParamsJson) ??
    (resultSessionParams &&
    typeof resultSessionParams === "object" &&
    !Array.isArray(resultSessionParams)
      ? (resultSessionParams as Record<string, unknown>)
      : {});

  return {
    id: s.id,
    status: s.status ?? "unknown",
    agentId: s.agentId,
    adapter: s.adapter,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    durationMs: s.durationMs,
    errorMessage: s.errorMessage,
    prompt: s.prompt,
    config: safeJson(s.configJson) ?? {},
    runtime: safeJson(s.runtimeJson) ?? {},
    sessionParams,
    result,
    usage: safeJson(s.usageJson),
    sessionDisplayId: s.sessionDisplayId,
    parentSessionId: s.parentSessionId,
    wakeupId: s.wakeupId,
    transcript,
    wakeup,
  };
}

export interface ExecutionAttemptSummary {
  id: string;
  status: string;
  agentId: string;
  harness: string;
  workflowRunId: string;
  workItemId: string;
  harnessSessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ExecutionGoalProgress {
  id: string;
  title: string;
  total: number;
  completed: number;
  active: number;
  proposed: number;
  ready: number;
  blocked: number;
  failed: number;
  percent: number;
}

export async function listExecutionGoalProgress(): Promise<ExecutionGoalProgress[]> {
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  const goalRows = await handle.db.select().from(goals).orderBy(desc(goals.updatedAt));
  const result: ExecutionGoalProgress[] = [];
  for (const goal of goalRows) {
    const items = await handle.db
      .select({ status: executionWorkItems.status })
      .from(executionWorkItems)
      .where(eq(executionWorkItems.goalId, goal.id));
    const completed = items.filter((item) => item.status === "completed").length;
    const active = items.filter((item) => ["claimed", "in_progress"].includes(item.status)).length;
    const proposed = items.filter((item) => item.status === "proposed").length;
    const ready = items.filter((item) => item.status === "ready").length;
    const blocked = items.filter((item) => item.status === "blocked").length;
    const failed = items.filter((item) => item.status === "failed").length;
    result.push({
      id: goal.id,
      title: goal.title,
      total: items.length,
      completed,
      active,
      proposed,
      ready,
      blocked,
      failed,
      percent: items.length === 0 ? 0 : Math.round((completed / items.length) * 100),
    });
  }
  return result;
}

export async function listExecutionAttempts(limit = 50): Promise<ExecutionAttemptSummary[]> {
  ensureWorkspaceEnv();
  const rows = await getDefaultDb()
    .db.select()
    .from(agentAttempts)
    .orderBy(desc(agentAttempts.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    agentId: row.agentId,
    harness: row.harness,
    workflowRunId: row.workflowRunId,
    workItemId: row.workItemId,
    harnessSessionId: row.harnessSessionId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }));
}

export interface ExecutionAttemptDetail {
  attempt: ExecutionAttemptSummary & {
    organizationId: string;
    attemptNumber: number;
    error: string | null;
  };
  workItem: Record<string, unknown> | null;
  project: Record<string, unknown> | null;
  goal: Record<string, unknown> | null;
  repository: Record<string, unknown> | null;
  revision: Record<string, unknown> | null;
  workspace: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  harnessSession: Record<string, unknown> | null;
  events: Array<{
    id: number;
    seq: number;
    ts: string;
    type: string;
    payload: Record<string, unknown>;
  }>;
  artifacts: Record<string, unknown>[];
}

export async function getExecutionAttemptDetail(
  id: string,
): Promise<ExecutionAttemptDetail | null> {
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  const attemptRows = await handle.db
    .select()
    .from(agentAttempts)
    .where(eq(agentAttempts.id, id))
    .limit(1);
  const attempt = attemptRows[0];
  if (!attempt) return null;

  const workItem = (
    await handle.db
      .select()
      .from(executionWorkItems)
      .where(eq(executionWorkItems.id, attempt.workItemId))
      .limit(1)
  )[0];
  const project = workItem
    ? (
        await handle.db.select().from(projects).where(eq(projects.id, workItem.projectId)).limit(1)
      )[0]
    : undefined;
  const goal = project
    ? (await handle.db.select().from(goals).where(eq(goals.id, project.goalId)).limit(1))[0]
    : undefined;
  const repository = workItem
    ? (
        await handle.db
          .select()
          .from(repositories)
          .where(eq(repositories.id, workItem.repositoryId))
          .limit(1)
      )[0]
    : undefined;
  const revision = workItem?.definitionRevisionId
    ? (
        await handle.db
          .select()
          .from(definitionRevisions)
          .where(eq(definitionRevisions.id, workItem.definitionRevisionId))
          .limit(1)
      )[0]
    : undefined;
  const workspace = (
    await handle.db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.attemptId, id))
      .limit(1)
  )[0];
  const plan = (
    await handle.db.select().from(executionPlans).where(eq(executionPlans.attemptId, id)).limit(1)
  )[0];
  // Load the linked legacy session so the detail view can expose the full transcript.
  const harnessSession = attempt.harnessSessionId
    ? (
        await handle.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, attempt.harnessSessionId))
          .limit(1)
      )[0]
    : undefined;
  const eventRows = await handle.db
    .select()
    .from(executionEvents)
    .where(eq(executionEvents.attemptId, id))
    .orderBy(asc(executionEvents.seq));
  const artifactRows = await handle.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.attemptId, id))
    .orderBy(asc(artifacts.createdAt));

  return {
    attempt: {
      id: attempt.id,
      organizationId: attempt.organizationId,
      status: attempt.status,
      agentId: attempt.agentId,
      harness: attempt.harness,
      workflowRunId: attempt.workflowRunId,
      workItemId: attempt.workItemId,
      harnessSessionId: attempt.harnessSessionId,
      attemptNumber: attempt.attemptNumber,
      createdAt: attempt.createdAt,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      error: attempt.error,
    },
    workItem: workItem ? { ...workItem, metadata: safeJson(workItem.metadataJson) ?? {} } : null,
    project: project ?? null,
    goal: goal ?? null,
    repository: repository ?? null,
    revision: revision ?? null,
    workspace: workspace ?? null,
    plan: plan
      ? {
          ...plan,
          sourceSnapshot: safeJson(plan.sourceSnapshotJson) ?? {},
          target: safeJson(plan.targetJson) ?? {},
          runtimeConfig: safeJson(plan.runtimeConfigJson) ?? {},
        }
      : null,
    harnessSession: harnessSession ?? null,
    events: eventRows.map((event) => ({
      id: event.id,
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      payload: safeJson(event.payloadJson) ?? {},
    })),
    artifacts: artifactRows,
  };
}
