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
import { getDefaultDb, sessions, wakeups } from "@aaspai/db";
import { FileAgentConfigSource } from "@aaspai/file-loader";
import { desc, eq } from "drizzle-orm";

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
