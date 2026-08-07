/**
 * Conversation threads for the inbox.
 *
 * A conversation is a chain of `sessions` rows linked through
 * `parentSessionId` (the root is the first turn). Each session is one
 * user turn + one assistant turn; its full transcript lives in
 * `session_events`. Restoring a conversation walks the chain in order,
 * concatenates every turn's events, and renders them as standard AI SDK
 * `UIMessage`s (via `buildUIMessages`).
 */

import {
  and,
  asc,
  desc,
  eq,
  getDefaultDb,
  inArray,
  runMigrations,
  sessionEvents,
  sessions,
} from "@aaspai/db";
import type { UIMessage } from "ai";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { buildUIMessages } from "@/lib/transcript";

const CHAT_WAKEUP_PREFIX = "chat_";

export interface ConversationSummary {
  /** Root session id — stable thread identity. */
  id: string;
  agentId: string;
  adapter: string;
  /** First turn's prompt, truncated for the sidebar. */
  title: string;
  /** Wall-clock of the most recent turn. */
  updatedAt: string;
  turnCount: number;
  /** Status of the most recent turn. */
  status: string;
}

export interface ConversationResume {
  /** Last session's row id — next turn sets this as its parent. */
  parentSessionId: string | null;
  /** Last session's runtime session id — adapter `--session` resume. */
  resumeSessionId: string | null;
  resumeSessionParams: Record<string, unknown> | null;
}

export interface ConversationDetail {
  id: string;
  agentId: string;
  adapter: string;
  title: string;
  updatedAt: string;
  turnCount: number;
  status: string;
  messages: UIMessage[];
  resume: ConversationResume;
}

function truncateTitle(prompt: string): string {
  const single = prompt.replace(/\s+/g, " ").trim();
  return single.length > 60 ? `${single.slice(0, 60)}…` : single;
}

/**
 * List conversation threads (newest turn first). Loads a bounded set of
 * the org's sessions, groups children by parent, and walks up to find
 * each chain's root. Only threads whose chain includes a `chat_`-wakeup
 * session are returned (those are inbox conversations).
 */
export async function listConversations(
  organizationId: string,
  limit = 50,
  agentId?: string,
): Promise<ConversationSummary[]> {
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  const maxRows = Math.min(Math.max(limit, 1), 200) * 6;

  const where = agentId
    ? and(eq(sessions.organizationId, organizationId), eq(sessions.agentId, agentId))
    : eq(sessions.organizationId, organizationId);
  const rows = await handle.db
    .select({
      id: sessions.id,
      organizationId: sessions.organizationId,
      agentId: sessions.agentId,
      adapter: sessions.adapter,
      wakeupId: sessions.wakeupId,
      prompt: sessions.prompt,
      status: sessions.status,
      startedAt: sessions.startedAt,
      finishedAt: sessions.finishedAt,
      parentSessionId: sessions.parentSessionId,
      sessionId: sessions.sessionId,
      sessionParamsJson: sessions.sessionParamsJson,
    })
    .from(sessions)
    .where(where)
    .orderBy(desc(sessions.startedAt))
    .limit(maxRows);

  // Index rows by id and map children → parents.
  const byId = new Map<string, (typeof rows)[number]>();
  const childrenOf = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    byId.set(row.id, row);
    if (row.parentSessionId) {
      const list = childrenOf.get(row.parentSessionId) ?? [];
      list.push(row);
      childrenOf.set(row.parentSessionId, list);
    }
  }

  // A row is a conversation root when it's a `chat_`-wakeup row whose
  // parent isn't itself a chat row (avoid double-listing chains).
  const roots: (typeof rows)[number][] = [];
  for (const row of rows) {
    if (!isChatRow(row)) continue;
    const parent = row.parentSessionId ? byId.get(row.parentSessionId) : undefined;
    if (!parent || !isChatRow(parent)) roots.push(row);
  }

  const summaries: ConversationSummary[] = [];
  for (const root of roots) {
    const chain = collectChain(root, byId);
    const turns = chain.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    const last = turns[turns.length - 1] ?? root;
    const first = turns[0] ?? root;
    summaries.push({
      id: root.id,
      agentId: root.agentId,
      adapter: root.adapter,
      title: truncateTitle(first.prompt || root.prompt),
      updatedAt: last.finishedAt ?? last.startedAt ?? root.startedAt ?? "",
      turnCount: turns.length,
      status: last.status ?? "unknown",
    });
  }

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

/** Walk a parent chain upward to find the true root of a session. */
export async function findConversationRoot(
  organizationId: string,
  sessionId: string,
): Promise<string | null> {
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  let current = sessionId;
  for (let depth = 0; depth < 64; depth += 1) {
    const [row] = await handle.db
      .select({ id: sessions.id, parentSessionId: sessions.parentSessionId })
      .from(sessions)
      .where(and(eq(sessions.id, current), eq(sessions.organizationId, organizationId)))
      .limit(1);
    if (!row) return null;
    if (!row.parentSessionId) return row.id;
    current = row.parentSessionId;
  }
  return null;
}

/**
 * Load a conversation's full transcript as AI SDK `UIMessage`s plus the
 * resume payload for continuing it.
 */
export async function getConversationDetail(
  organizationId: string,
  rootId: string,
): Promise<ConversationDetail | null> {
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  const [root] = await handle.db
    .select({
      id: sessions.id,
      organizationId: sessions.organizationId,
      agentId: sessions.agentId,
      adapter: sessions.adapter,
      wakeupId: sessions.wakeupId,
      prompt: sessions.prompt,
      status: sessions.status,
      startedAt: sessions.startedAt,
      finishedAt: sessions.finishedAt,
      parentSessionId: sessions.parentSessionId,
      sessionId: sessions.sessionId,
      sessionParamsJson: sessions.sessionParamsJson,
    })
    .from(sessions)
    .where(and(eq(sessions.id, rootId), eq(sessions.organizationId, organizationId)))
    .limit(1);
  if (!root || !isChatRow(root)) return null;

  // Walk the full chain (root → children → grandchildren) so
  // conversations with many turns restore completely.
  const chain = [root];
  const visited = new Set<string>([root.id]);
  let frontier = [root.id];
  while (frontier.length > 0) {
    const children = await handle.db
      .select({
        id: sessions.id,
        organizationId: sessions.organizationId,
        agentId: sessions.agentId,
        adapter: sessions.adapter,
        wakeupId: sessions.wakeupId,
        prompt: sessions.prompt,
        status: sessions.status,
        startedAt: sessions.startedAt,
        finishedAt: sessions.finishedAt,
        parentSessionId: sessions.parentSessionId,
        sessionId: sessions.sessionId,
        sessionParamsJson: sessions.sessionParamsJson,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.organizationId, organizationId),
          inArray(sessions.parentSessionId, frontier),
        ),
      )
      .orderBy(asc(sessions.startedAt));
    const nextFrontier: string[] = [];
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      chain.push(child);
      nextFrontier.push(child.id);
    }
    frontier = nextFrontier;
  }
  chain.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const messages: UIMessage[] = [];

  for (const turn of chain) {
    const events = await handle.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, turn.id))
      .orderBy(asc(sessionEvents.seq));

    const entries = events.map((e) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(e.payloadJson) as Record<string, unknown>;
      } catch {
        payload = { raw: e.payloadJson };
      }
      return { seq: e.seq, kind: e.kind, payload, ts: e.ts };
    });

    // User turn: the prompt is the user's message.
    if (turn.prompt.trim()) {
      messages.push({
        id: `u-${turn.id}`,
        role: "user",
        parts: [{ type: "text", text: turn.prompt, state: "done" }],
      });
    }
    // Assistant turn: normalized UIMessage parts from the event stream.
    messages.push(...buildUIMessages(entries));
  }

  const last = chain[chain.length - 1] ?? root;
  const params = safeJson(last.sessionParamsJson) ?? {};
  const resumeSessionId = last.sessionId ?? null;

  return {
    id: root.id,
    agentId: root.agentId,
    adapter: root.adapter,
    title: truncateTitle(root.prompt),
    updatedAt: last.finishedAt ?? last.startedAt ?? root.startedAt ?? "",
    turnCount: chain.length,
    status: last.status ?? "unknown",
    messages,
    resume: {
      parentSessionId: last.id,
      resumeSessionId,
      resumeSessionParams: Object.keys(params).length > 0 ? params : null,
    },
  };
}

/**
 * Delete a conversation thread (root + all chained sessions). Only the
 * owner org may delete; `session_events` cascade via FK.
 */
export async function deleteConversation(organizationId: string, rootId: string): Promise<boolean> {
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  // Collect the full chain first (org-scoped at every hop).
  const chain = await collectChainRows(organizationId, rootId);
  if (chain.length === 0) return false;

  // Delete children before roots (events cascade, rows are plain text ids).
  const ordered = [...chain].sort((a, b) => {
    const depthA = a.parentSessionId ? chain.findIndex((r) => r.id === a.parentSessionId) : -1;
    const depthB = b.parentSessionId ? chain.findIndex((r) => r.id === b.parentSessionId) : -1;
    return depthB - depthA;
  });
  for (const row of ordered) {
    await handle.db
      .delete(sessions)
      .where(eq(sessions.id, row.id))
      .catch(() => undefined);
  }
  return true;
}

/** Org-scoped walk that returns all rows in a conversation chain. */
async function collectChainRows(
  organizationId: string,
  rootId: string,
): Promise<Array<{ id: string; parentSessionId: string | null }>> {
  const handle = getDefaultDb();
  const [root] = await handle.db
    .select({ id: sessions.id, parentSessionId: sessions.parentSessionId })
    .from(sessions)
    .where(and(eq(sessions.id, rootId), eq(sessions.organizationId, organizationId)))
    .limit(1);
  if (!root) return [];

  const rows: Array<{ id: string; parentSessionId: string | null }> = [root];
  const visited = new Set<string>([root.id]);
  let frontier = [root.id];
  while (frontier.length > 0) {
    const children = await handle.db
      .select({ id: sessions.id, parentSessionId: sessions.parentSessionId })
      .from(sessions)
      .where(
        and(
          eq(sessions.organizationId, organizationId),
          inArray(sessions.parentSessionId, frontier),
        ),
      );
    const next: string[] = [];
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      rows.push(child);
      next.push(child.id);
    }
    frontier = next;
  }
  return rows;
}

function isChatRow(row: { wakeupId: string | null }): boolean {
  return row.wakeupId?.startsWith(CHAT_WAKEUP_PREFIX) ?? false;
}

function collectChain<T extends { id: string; parentSessionId: string | null }>(
  root: T,
  byId: Map<string, T>,
): T[] {
  const chain = [root];
  const seen = new Set<string>([root.id]);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as T;
    for (const row of byId.values()) {
      if (row.parentSessionId === current.id && !seen.has(row.id)) {
        seen.add(row.id);
        chain.push(row);
        stack.push(row);
      }
    }
  }
  return chain;
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
