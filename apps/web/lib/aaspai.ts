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
  type AutonomyChangeRequest,
  type AutonomyProposal,
  autonomyChangeRequestSchema,
  autonomyProposalSchema,
  type CompanyHealth,
  type MemoryRecord,
  memoryRecordSchema,
} from "@aaspai/contracts";
import {
  agentAttempts,
  artifacts,
  autonomyChangeRequests,
  autonomyProposals,
  definitionRevisions,
  executionApprovals,
  executionBudgetReservations,
  executionEvents,
  executionGovernanceEvents,
  executionPlans,
  executionVerifications,
  executionWorkItemDependencies,
  executionWorkItems,
  executionWorkspaces,
  getDefaultDb,
  goals,
  knowledgeProposals,
  loopOutputs,
  memoryRecords,
  projects,
  repositories,
  runMigrations,
  sessionEvents,
  sessions,
  temporalFacts,
  wakeups,
  workflowRuns,
} from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { FileAgentConfigSource } from "@aaspai/file-loader";
import type { KnowledgeSnapshot } from "@aaspai/knowledge";
import { createKnowledgeCurator } from "@aaspai/knowledge";
import { asc, desc, eq } from "drizzle-orm";

/**
 * Resolve the workspace root and pin `AASPAI_CWD` + `AASPAI_DB` so
 * that downstream consumers (db, sessions, file-loader) open files
 * relative to the workspace, not to the dev server's `process.cwd()`.
 *
 * Idempotent — safe to call from any data accessor.
 */
export function ensureWorkspaceEnv(): void {
  const root = workspaceRoot();
  process.env.AASPAI_CWD = root;
  if (!process.env.AASPAI_DB) {
    process.env.AASPAI_DB = `sqlite:${join(root, ".aaspai", "state.db")}`;
  }
}

export async function getKnowledgeSnapshot(): Promise<
  KnowledgeSnapshot & { organizationId: string | null }
> {
  ensureWorkspaceEnv();
  if (!isAaspaiWorkspace()) {
    return { organizationId: null, facts: [], proposals: [], changeRequests: [], signals: [] };
  }
  const handle = getDefaultDb();
  runMigrations(handle);
  const [factRows, proposalRows, goalRows] = await Promise.all([
    handle.db.select({ organizationId: temporalFacts.organizationId }).from(temporalFacts),
    handle.db
      .select({ organizationId: knowledgeProposals.organizationId })
      .from(knowledgeProposals),
    handle.db.select({ organizationId: goals.organizationId }).from(goals),
  ]);
  const organizationId = firstOrganizationId([factRows, proposalRows, goalRows]);
  if (!organizationId) {
    return { organizationId: null, facts: [], proposals: [], changeRequests: [], signals: [] };
  }
  return { organizationId, ...(await createKnowledgeCurator(handle.db).snapshot(organizationId)) };
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

export async function listMemoryRecords(
  options: { organizationId?: string; query?: string; limit?: number } = {},
): Promise<MemoryRecord[]> {
  ensureWorkspaceEnv();
  if (!isAaspaiWorkspace()) return [];
  const handle = getDefaultDb();
  runMigrations(handle);
  const rows = await handle.db.select().from(memoryRecords).orderBy(desc(memoryRecords.createdAt));
  const organizationId =
    options.organizationId ?? rows.find((row) => row.organizationId)?.organizationId;
  const query = options.query?.trim().toLowerCase() ?? "";
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const records: MemoryRecord[] = [];
  for (const row of rows) {
    if (organizationId && row.organizationId !== organizationId) continue;
    const parsed = memoryRecordSchema.safeParse({
      id: row.id,
      organizationId: row.organizationId,
      kind: row.kind,
      title: row.title,
      content: row.content,
      contentHash: row.contentHash,
      scope: parseJsonValue(row.scopeJson, {}),
      sensitivity: row.sensitivity,
      provenance: parseJsonValue(row.provenanceJson, {}),
      evidence: parseJsonValue(row.evidenceJson, []),
      retention: parseJsonValue(row.retentionJson, {}),
      status: row.status,
      tags: parseJsonValue(row.tagsJson, []),
      relatedIds: parseJsonValue(row.relatedIdsJson, []),
      supersedesId: row.supersedesId,
      metadata: parseJsonValue(row.metadataJson, {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    if (!parsed.success) continue;
    const record = parsed.data;
    const haystack = `${record.title} ${record.content} ${record.tags.join(" ")}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    records.push(record);
    if (records.length >= limit) break;
  }
  return records;
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

function parseJsonValue<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
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

export async function listAutonomyChangeRequests(
  organizationId?: string,
): Promise<AutonomyChangeRequest[]> {
  ensureWorkspaceEnv();
  if (!isAaspaiWorkspace()) return [];
  const handle = getDefaultDb();
  runMigrations(handle);
  const rows = await handle.db
    .select()
    .from(autonomyChangeRequests)
    .orderBy(desc(autonomyChangeRequests.updatedAt));
  const scopedOrganizationId =
    organizationId ?? rows.find((row) => row.organizationId)?.organizationId;
  return rows.flatMap((row) => {
    if (scopedOrganizationId && row.organizationId !== scopedOrganizationId) return [];
    const parsed = autonomyChangeRequestSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function listAutonomyProposals(organizationId?: string): Promise<AutonomyProposal[]> {
  ensureWorkspaceEnv();
  if (!isAaspaiWorkspace()) return [];
  const handle = getDefaultDb();
  runMigrations(handle);
  const rows = await handle.db
    .select()
    .from(autonomyProposals)
    .orderBy(desc(autonomyProposals.updatedAt));
  const scopedOrganizationId =
    organizationId ?? rows.find((row) => row.organizationId)?.organizationId;
  return rows.flatMap((row) => {
    if (scopedOrganizationId && row.organizationId !== scopedOrganizationId) return [];
    const { evidenceJson, ...portable } = row;
    const parsed = autonomyProposalSchema.safeParse({
      ...portable,
      evidence: safeJson(evidenceJson) ?? {},
    });
    return parsed.success ? [parsed.data] : [];
  });
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

export interface CompanyGoalSummary {
  id: string;
  title: string;
  description: string;
  status: string;
  total: number;
  completed: number;
  active: number;
  ready: number;
  blocked: number;
  waiting: number;
  failed: number;
  percent: number;
}

export interface CompanyWorkItemSummary {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  goalId: string;
  projectId: string;
  projectTitle: string | null;
  repositoryId: string;
  repositoryTitle: string | null;
  branchName: string | null;
  owner: string | null;
  attemptId: string | null;
  harness: string | null;
  blockedReason: string | null;
  dependencyIds: string[];
  dependencyTitles: string[];
  approvalRequired: boolean;
  verificationRequired: boolean;
  evidenceCount: number;
  updatedAt: string;
}

export interface CompanyRunSummary {
  id: string;
  goalId: string;
  status: string;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: string;
  attemptCount: number;
}

export interface CompanyApprovalSummary {
  id: string;
  workItemId: string;
  workItemTitle: string | null;
  attemptId: string | null;
  status: string;
  actorType: string;
  reason: string;
  requestedAt: string;
  expiresAt: string | null;
}

export interface CompanyEvidenceSummary {
  id: string;
  title: string;
  body: string;
  kind: string;
  severity: string | null;
  workItemId: string | null;
  workflowRunId: string;
  createdAt: string;
}

export interface CompanyOverview {
  organizationId: string | null;
  workspace: string;
  health: CompanyHealth | null;
  goals: CompanyGoalSummary[];
  projects: Array<{
    id: string;
    goalId: string;
    title: string;
    description: string;
    status: string;
    repositoryCount: number;
  }>;
  repositories: Array<{
    id: string;
    projectId: string | null;
    purpose: string;
    provider: string;
    localPath: string;
    remoteUrl: string | null;
    defaultBranch: string;
  }>;
  revisions: Array<{
    id: string;
    repositoryId: string;
    commitSha: string;
    sourcePath: string;
    dirty: boolean;
    createdAt: string;
  }>;
  workItems: CompanyWorkItemSummary[];
  approvals: CompanyApprovalSummary[];
  runs: CompanyRunSummary[];
  attempts: ExecutionAttemptSummary[];
  evidence: CompanyEvidenceSummary[];
  agents: AgentSummary[];
  governance: Array<{
    id: string;
    action: string;
    decision: string;
    reason: string;
    workItemId: string | null;
    attemptId: string | null;
    occurredAt: string;
  }>;
  budget: {
    reservedCostUsd: number;
    actualCostUsd: number;
    reservedTokens: number;
    actualTokens: number;
  };
  stats: {
    completedWork: number;
    activeWork: number;
    blockedWork: number;
    pendingApprovals: number;
    runningAttempts: number;
    failedAttempts: number;
    totalAttempts: number;
    totalEvidence: number;
  };
}

/**
 * Build the command-center read model from the durable execution tables.
 * This keeps the page useful in the local workspace today and gives the API
 * layer a stable projection to expose when the web app becomes multi-tenant.
 */
export async function getCompanyOverview(): Promise<CompanyOverview> {
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  const db = handle.db;
  const [
    goalRows,
    projectRows,
    repositoryRows,
    revisionRows,
    workItemRows,
    dependencyRows,
    runRows,
    attemptRows,
    approvalRows,
    verificationRows,
    outputRows,
    governanceRows,
    budgetRows,
  ] = await Promise.all([
    db.select().from(goals).orderBy(desc(goals.updatedAt)),
    db.select().from(projects).orderBy(desc(projects.updatedAt)),
    db.select().from(repositories).orderBy(desc(repositories.updatedAt)),
    db.select().from(definitionRevisions).orderBy(desc(definitionRevisions.createdAt)),
    db
      .select()
      .from(executionWorkItems)
      .orderBy(desc(executionWorkItems.priority), desc(executionWorkItems.updatedAt)),
    db.select().from(executionWorkItemDependencies),
    db.select().from(workflowRuns).orderBy(desc(workflowRuns.createdAt)),
    db.select().from(agentAttempts).orderBy(desc(agentAttempts.createdAt)),
    db.select().from(executionApprovals).orderBy(desc(executionApprovals.requestedAt)),
    db.select().from(executionVerifications),
    db.select().from(loopOutputs).orderBy(desc(loopOutputs.createdAt)),
    db.select().from(executionGovernanceEvents).orderBy(desc(executionGovernanceEvents.occurredAt)),
    db.select().from(executionBudgetReservations),
  ]);

  const organizationId = firstOrganizationId([
    goalRows,
    projectRows,
    repositoryRows,
    workItemRows,
    runRows,
    attemptRows,
  ]);
  const inCompany = (row: { organizationId: string }) =>
    organizationId === null || row.organizationId === organizationId;
  const companyGoals = goalRows.filter(inCompany);
  const companyProjects = projectRows.filter(inCompany);
  const companyRepositories = repositoryRows.filter(inCompany);
  const companyRevisions = revisionRows.filter(inCompany);
  const companyWorkItems = workItemRows.filter(inCompany);
  const companyRuns = runRows.filter(inCompany);
  const companyAttempts = attemptRows.filter(inCompany);
  const companyApprovals = approvalRows.filter(inCompany);
  const companyVerifications = verificationRows.filter(inCompany);
  const companyOutputs = outputRows.filter(inCompany);
  const companyGovernance = governanceRows.filter(inCompany);
  const companyBudgets = budgetRows.filter(inCompany);
  const health = organizationId
    ? await new ExecutionStore(db).getCompanyHealth(organizationId)
    : null;
  const projectById = new Map(companyProjects.map((project) => [project.id, project]));
  const repositoryById = new Map(
    companyRepositories.map((repository) => [repository.id, repository]),
  );
  const workItemById = new Map(companyWorkItems.map((item) => [item.id, item]));
  const attemptById = new Map(companyAttempts.map((attempt) => [attempt.id, attempt]));
  const dependenciesByWorkItem = new Map<string, typeof dependencyRows>();
  for (const dependency of dependencyRows.filter(
    (row) => organizationId === null || row.organizationId === organizationId,
  )) {
    const current = dependenciesByWorkItem.get(dependency.workItemId) ?? [];
    current.push(dependency);
    dependenciesByWorkItem.set(dependency.workItemId, current);
  }
  const evidenceByAttempt = new Map<string, number>();
  const artifactsByAttempt = new Map<string, number>();
  const artifactRows = await db.select().from(artifacts);
  for (const artifact of artifactRows.filter(inCompany)) {
    artifactsByAttempt.set(
      artifact.attemptId,
      (artifactsByAttempt.get(artifact.attemptId) ?? 0) + 1,
    );
  }
  for (const verification of companyVerifications) {
    const evidenceIds = parseJsonList(verification.evidenceIdsJson);
    evidenceByAttempt.set(
      verification.makerAttemptId,
      Array.isArray(evidenceIds) ? evidenceIds.length : 0,
    );
  }
  const goalProgress = companyGoals.map((goal) => {
    const items = companyWorkItems.filter((item) => item.goalId === goal.id);
    const completed = items.filter((item) => item.status === "completed").length;
    return {
      id: goal.id,
      title: goal.title,
      description: goal.description,
      status: goal.status,
      total: items.length,
      completed,
      active: items.filter((item) => ["claimed", "in_progress"].includes(item.status)).length,
      ready: items.filter((item) => item.status === "ready").length,
      blocked: items.filter((item) => item.status === "blocked").length,
      waiting: items.filter((item) => item.status === "proposed").length,
      failed: items.filter((item) => item.status === "failed").length,
      percent: items.length === 0 ? 0 : Math.round((completed / items.length) * 100),
    };
  });
  const workItems = companyWorkItems.map((item) => {
    const dependencies = dependenciesByWorkItem.get(item.id) ?? [];
    const ownerAttempt = item.claimedByAttemptId
      ? attemptById.get(item.claimedByAttemptId)
      : undefined;
    const project = projectById.get(item.projectId);
    const repository = repositoryById.get(item.repositoryId);
    const governance = safeJson(item.governanceJson) as Record<string, unknown> | null;
    const approval = isRecordValue(governance?.approval) ? governance.approval : {};
    const verification = isRecordValue(governance?.verification) ? governance.verification : {};
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      goalId: item.goalId,
      projectId: item.projectId,
      projectTitle: project?.title ?? null,
      repositoryId: item.repositoryId,
      repositoryTitle: repository?.purpose ?? null,
      branchName: item.branchName,
      owner: ownerAttempt?.agentId ?? null,
      attemptId: ownerAttempt?.id ?? null,
      harness: ownerAttempt?.harness ?? null,
      blockedReason: item.blockedReason,
      dependencyIds: dependencies.map((dependency) => dependency.dependsOnWorkItemId),
      dependencyTitles: dependencies.map(
        (dependency) =>
          workItemById.get(dependency.dependsOnWorkItemId)?.title ?? dependency.dependsOnWorkItemId,
      ),
      approvalRequired: approval.required === true,
      verificationRequired: verification.required === true,
      evidenceCount:
        companyOutputs.filter((output) => output.workItemId === item.id).length +
        (ownerAttempt ? (evidenceByAttempt.get(ownerAttempt.id) ?? 0) : 0) +
        (ownerAttempt ? (artifactsByAttempt.get(ownerAttempt.id) ?? 0) : 0),
      updatedAt: item.updatedAt,
    };
  });
  const attempts = companyAttempts.map((attempt) => ({
    id: attempt.id,
    status: attempt.status,
    agentId: attempt.agentId,
    harness: attempt.harness,
    workflowRunId: attempt.workflowRunId,
    workItemId: attempt.workItemId,
    harnessSessionId: attempt.harnessSessionId,
    createdAt: attempt.createdAt,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
  }));
  const attemptCountByRun = new Map<string, number>();
  for (const attempt of companyAttempts) {
    attemptCountByRun.set(
      attempt.workflowRunId,
      (attemptCountByRun.get(attempt.workflowRunId) ?? 0) + 1,
    );
  }

  return {
    organizationId,
    workspace: workspaceRoot(),
    health,
    goals: goalProgress,
    projects: companyProjects.map((project) => ({
      id: project.id,
      goalId: project.goalId,
      title: project.title,
      description: project.description,
      status: project.status,
      repositoryCount: companyRepositories.filter(
        (repository) => repository.projectId === project.id,
      ).length,
    })),
    repositories: companyRepositories.map((repository) => ({
      id: repository.id,
      projectId: repository.projectId,
      purpose: repository.purpose,
      provider: repository.provider,
      localPath: repository.localPath,
      remoteUrl: repository.remoteUrl,
      defaultBranch: repository.defaultBranch,
    })),
    revisions: companyRevisions.map((revision) => ({
      id: revision.id,
      repositoryId: revision.repositoryId,
      commitSha: revision.commitSha,
      sourcePath: revision.sourcePath,
      dirty: revision.dirty,
      createdAt: revision.createdAt,
    })),
    workItems,
    approvals: companyApprovals.map((approval) => ({
      id: approval.id,
      workItemId: approval.workItemId,
      workItemTitle: workItemById.get(approval.workItemId)?.title ?? null,
      attemptId: workItemById.get(approval.workItemId)?.claimedByAttemptId ?? null,
      status: approval.status,
      actorType: approval.actorType,
      reason: approval.reason,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
    })),
    runs: companyRuns.slice(0, 20).map((run) => ({
      id: run.id,
      goalId: run.goalId,
      status: run.status,
      sourceType: run.sourceType,
      sourceId: run.sourceId,
      createdAt: run.createdAt,
      attemptCount: attemptCountByRun.get(run.id) ?? 0,
    })),
    attempts: attempts.slice(0, 20),
    evidence: companyOutputs.slice(0, 20).map((output) => ({
      id: output.id,
      title: output.title,
      body: output.body,
      kind: output.kind,
      severity: output.severity,
      workItemId: output.workItemId,
      workflowRunId: output.workflowRunId,
      createdAt: output.createdAt,
    })),
    agents: await listAgents(),
    governance: companyGovernance.slice(0, 30).map((event) => ({
      id: event.id,
      action: event.action,
      decision: event.decision,
      reason: event.reason,
      workItemId: event.workItemId,
      attemptId: event.attemptId,
      occurredAt: event.occurredAt,
    })),
    budget: {
      reservedCostUsd: companyBudgets.reduce((sum, row) => sum + row.reservedCostUsd, 0),
      actualCostUsd: companyBudgets.reduce((sum, row) => sum + row.actualCostUsd, 0),
      reservedTokens: companyBudgets.reduce((sum, row) => sum + row.reservedTokens, 0),
      actualTokens: companyBudgets.reduce((sum, row) => sum + row.actualTokens, 0),
    },
    stats: {
      completedWork: companyWorkItems.filter((item) => item.status === "completed").length,
      activeWork: companyWorkItems.filter((item) =>
        ["claimed", "in_progress"].includes(item.status),
      ).length,
      blockedWork: companyWorkItems.filter((item) => item.status === "blocked").length,
      pendingApprovals: companyApprovals.filter((approval) => approval.status === "requested")
        .length,
      runningAttempts: companyAttempts.filter((attempt) =>
        ["queued", "running"].includes(attempt.status),
      ).length,
      failedAttempts: companyAttempts.filter((attempt) => attempt.status === "failed").length,
      totalAttempts: companyAttempts.length,
      totalEvidence:
        companyOutputs.length +
        companyVerifications.reduce((sum, verification) => {
          const ids = parseJsonList(verification.evidenceIdsJson);
          return sum + (Array.isArray(ids) ? ids.length : 0);
        }, 0),
    },
  };
}

function firstOrganizationId(groups: Array<Array<{ organizationId: string }>>): string | null {
  for (const group of groups) {
    if (group[0]?.organizationId) return group[0].organizationId;
  }
  return null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonList(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
