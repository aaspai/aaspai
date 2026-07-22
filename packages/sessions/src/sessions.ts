/**
 * Sessions — the unified execution surface.
 *
 * Composes `@aaspai/harness` (the agent), `@aaspai/runtime` (where it
 * runs), `@aaspai/skills` (what it knows), and `@aaspai/knowledge` (its
 * context). Records every session to the DB and streams events back
 * through the caller's callbacks.
 *
 * Foundation slice: in-memory state for in-flight sessions. Phase 3
 * wires this to the DB-backed session store.
 */
import { randomUUID } from "node:crypto";
import type { TranscriptEntry } from "@aaspai/contracts/harness";
import {
  type AgentConfigSource,
  type KnowledgeSource,
  type PendingQuestion,
  pendingQuestionSchema,
  type SessionRequest,
  type SessionResult,
  type SessionState,
  type SessionStatus,
  sessionResultSchema,
} from "@aaspai/contracts/phase2";
import type { JsonObject } from "@aaspai/contracts/primitives";
import {
  getDefaultDb,
  type SessionEventInsert,
  type SessionInsert,
  sessionEvents as sessionEventsTable,
  sessions as sessionsTable,
} from "@aaspai/db";
import { type AdapterType, getAdapter } from "@aaspai/harness";
import { KnowledgeLoader } from "@aaspai/knowledge";
import { getLogger } from "@aaspai/observability";
import type { SkillRegistry } from "@aaspai/skills";

const log = getLogger("sessions");

export interface SessionsOptions {
  agentSource: AgentConfigSource;
  knowledgeSource: KnowledgeSource;
  skillRegistry: SkillRegistry;
}

export class Sessions {
  private readonly knowledgeLoader: KnowledgeLoader;
  private readonly inflight = new Map<string, PendingQuestion | null>();
  private started = false;

  constructor(private readonly opts: SessionsOptions) {
    this.knowledgeLoader = new KnowledgeLoader({ source: opts.knowledgeSource });
  }

  /**
   * Initialize the underlying sources. Call once before `execute()`.
   * Sources that don't need warm-up can be no-op; the file-based
   * sources do a chokidar scan + initial parse.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const maybeStart = (s: unknown) => {
      if (s && typeof (s as { start?: () => Promise<void> }).start === "function") {
        return (s as { start: () => Promise<void> }).start();
      }
    };
    await Promise.all([
      Promise.resolve(maybeStart(this.opts.agentSource)),
      Promise.resolve(maybeStart(this.opts.knowledgeSource)),
    ]);
  }

  /**
   * Execute a session. Composes the agent config, knowledge, and the
   * harness adapter into one run. Streams every onLog event into the
   * `session_events` table so the UI / STATE.md can render the
   * full transcript.
   */
  async execute(req: SessionRequest): Promise<SessionResult> {
    await this.start();
    log.info("execute", { agentId: req.agentId, adapter: req.adapter });

    // 1. Resolve the agent config
    const agent = await this.opts.agentSource.get(req.agentId);

    // 2. Load knowledge (resolved against the agent's include/exclude)
    const knowledge = await this.knowledgeLoader.loadFor(agent);

    // 3. Materialize skills (foundation: no-op until Phase 4)
    for (const ref of req.skills) {
      const skill = this.opts.skillRegistry.get(ref.key);
      if (skill) {
        // Foundation slice: just register; the actual write to disk happens
        // in a later phase when we know the runtime base path.
        this.opts.skillRegistry.register(skill);
      }
    }

    // 4. Build the session record
    const sessionId = `sess_${randomUUID()}`;
    const now = new Date().toISOString();
    const insert: SessionInsert = {
      id: sessionId,
      organizationId: req.organizationId,
      wakeupId: req.wakeupId ?? "manual",
      agentId: req.agentId,
      adapter: req.adapter,
      runtimeJson: JSON.stringify(req.runtime),
      prompt: req.prompt,
      configJson: JSON.stringify({
        ...req.config,
        agentConfig: { id: agent.id, adapter: agent.adapter },
      }),
      status: "running",
      sessionDisplayId: sessionId.slice(0, 8),
      startedAt: now,
    };
    const db = getDefaultDb();
    await db.db
      .insert(sessionsTable)
      .values({ ...insert, wakeupId: insert.wakeupId ?? "manual" } as never);

    // 5. Resolve the adapter and run the session
    const adapter = getAdapter(req.adapter as AdapterType);
    let seq = 0;
    const recordEvent = async (
      stream: "stdout" | "stderr",
      payload: JsonObject,
      kind: TranscriptEntry["kind"],
    ) => {
      seq += 1;
      const eventInsert: SessionEventInsert = {
        sessionId,
        ts: new Date().toISOString(),
        kind,
        payloadJson: JSON.stringify({ stream, ...payload }),
        seq,
      };
      try {
        await db.db.insert(sessionEventsTable).values(eventInsert as never);
      } catch (err) {
        log.warn("failed to record session event", { sessionId, seq, err: String(err) });
      }
    };

    // 5a. Build the full prompt — the dry-run adapter reads the system
    // prompt from context, real adapters just see a bigger prompt.
    const knowledgeBlock = knowledge.context ? `\n\n---\n\n${knowledge.context}\n` : "";
    const systemBlock =
      agent.systemPrompt.trim().length > 0 ? `${agent.systemPrompt.trim()}\n\n---\n\n` : "";
    const fullPrompt = `${systemBlock}${req.prompt}${knowledgeBlock}`;

    let result: SessionResult;
    const startedAtMs = Date.now();
    try {
      const adapterResult = await adapter.execute({
        protocolVersion: 1 as const,
        runId: sessionId,
        organizationId: req.organizationId,
        agent: {
          id: agent.id,
          organizationId: req.organizationId,
          name: agent.title,
          adapterType: agent.adapter as AdapterType,
          adapterConfig: agent.adapterConfig,
        },
        runtime: {
          sessionId: req.resume?.sessionId,
          sessionParams: req.resume?.sessionParams,
          sessionDisplayId: undefined,
          taskKey: undefined,
        },
        config: { ...agent.adapterConfig, ...(req.config ?? {}), systemPrompt: agent.systemPrompt },
        context: {
          cwd: req.cwd ?? process.cwd(),
          prompt: fullPrompt,
          role: agent.role,
        },
        onLog: async (stream, chunk) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (line.length === 0) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed && typeof parsed === "object" && "kind" in parsed) {
                const k = String((parsed as { kind: unknown }).kind);
                if (
                  [
                    "assistant",
                    "thinking",
                    "tool_call",
                    "tool_result",
                    "init",
                    "result",
                    "stderr",
                    "system",
                    "stdout",
                  ].includes(k)
                ) {
                  await recordEvent(stream, parsed as JsonObject, k as TranscriptEntry["kind"]);
                  continue;
                }
              }
            } catch {
              // Not JSON — emit as a raw line
            }
            await recordEvent(stream, { text: line }, stream === "stderr" ? "stderr" : "stdout");
          }
        },
        onMeta: async (meta) => {
          log.debug("adapter meta", { sessionId, meta });
        },
        onRuntimeProgress: async (update) => {
          log.debug("runtime progress", { sessionId, update });
        },
        onSpawn: async (meta) => {
          log.info("session spawned", { sessionId, pid: meta.pid });
        },
      });

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAtMs;
      const status: SessionStatus = adapterResult.timedOut
        ? "timed_out"
        : adapterResult.exitCode === 0
          ? "succeeded"
          : "failed";

      result = {
        sessionId: adapterResult.sessionId ?? sessionId,
        sessionDisplayId: adapterResult.sessionDisplayId,
        sessionParams: adapterResult.sessionParams,
        status,
        exitCode: adapterResult.exitCode,
        usage: adapterResult.usage,
        costUsd: adapterResult.costUsd,
        errorFamily: adapterResult.errorFamily,
        errorCode: adapterResult.errorCode,
        summary: adapterResult.summary,
        logRef: sessionId,
      };
      await db.db
        .update(sessionsTable)
        .set({
          status,
          finishedAt,
          durationMs,
          sessionId: result.sessionId,
          sessionParamsJson: result.sessionParams ? JSON.stringify(result.sessionParams) : null,
          sessionDisplayId: result.sessionDisplayId,
          resultJson: JSON.stringify(result),
          usageJson: result.usage ? JSON.stringify(result.usage) : null,
          costUsd: result.costUsd,
          errorFamily: result.errorFamily,
          errorCode: result.errorCode,
          // Only set errorMessage for actual failures. For successful
          // sessions the summary lives in the result JSON, not here.
          errorMessage:
            status === "succeeded" ? undefined : result.summary || result.errorCode || "failed",
        } as never)
        .where(eqId(sessionsTable.id, sessionId));
      log.info("session completed", { sessionId, status, durationMs, agent: agent.id });
      return result;
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAtMs;
      const errorFamily: SessionResult["errorFamily"] = ((): SessionResult["errorFamily"] => {
        const m = (err as Error).message ?? "";
        if (/auth|api key|unauthor/i.test(m)) return "auth";
        if (/quota|rate limit/i.test(m)) return "provider_quota";
        if (/timeout|timed out/i.test(m)) return "transient_upstream";
        return "internal";
      })();
      result = {
        sessionId,
        status: "failed",
        exitCode: 1,
        errorCode: "adapter_execution_failed",
        errorFamily,
        summary: (err as Error).message,
        logRef: sessionId,
      };
      await db.db
        .update(sessionsTable)
        .set({
          status: "failed",
          finishedAt,
          durationMs,
          resultJson: JSON.stringify(result),
          errorFamily,
          errorCode: result.errorCode,
          errorMessage: (err as Error).message,
        } as never)
        .where(eqId(sessionsTable.id, sessionId));
      log.error("session failed", { sessionId, err: (err as Error).message });
      return result;
    }
  }

  async get(id: string): Promise<SessionState | null> {
    const db = getDefaultDb();
    const rows = await db.db
      .select()
      .from(sessionsTable)
      .where(eqId(sessionsTable.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return rowToState(row);
  }

  async list(): Promise<readonly SessionState[]> {
    const db = getDefaultDb();
    const rows = await db.db.select().from(sessionsTable).orderBy(sessionsTable.startedAt);
    return rows.map(rowToState);
  }

  async pause(id: string, reason: string): Promise<void> {
    const db = getDefaultDb();
    await db.db
      .update(sessionsTable)
      .set({
        status: "paused_for_question",
        pendingQuestionJson: JSON.stringify({
          pausedReason: reason,
          askedAt: new Date().toISOString(),
          prompt: reason,
        }),
      } as never)
      .where(eqId(sessionsTable.id, id));
    log.info("session paused", { id, reason });
  }

  async resume(id: string, _answer?: string): Promise<SessionResult | null> {
    const db = getDefaultDb();
    await db.db
      .update(sessionsTable)
      .set({ status: "running", pendingQuestionJson: null } as never)
      .where(eqId(sessionsTable.id, id));
    log.info("session resumed", { id });
    return null;
  }

  async stop(id: string, reason: string): Promise<void> {
    const db = getDefaultDb();
    await db.db
      .update(sessionsTable)
      .set({
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        errorMessage: `Stopped: ${reason}`,
      } as never)
      .where(eqId(sessionsTable.id, id));
    log.info("session stopped", { id, reason });
  }

  async cancel(id: string, reason: string): Promise<void> {
    const db = getDefaultDb();
    await db.db
      .update(sessionsTable)
      .set({
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        errorMessage: `Cancelled: ${reason}`,
      } as never)
      .where(eqId(sessionsTable.id, id));
    log.info("session cancelled", { id, reason });
  }
}

import { eq } from "drizzle-orm";

function eqId<T>(col: T, val: string) {
  return eq(col as never, val as never);
}

function rowToState(row: typeof sessionsTable.$inferSelect): SessionState {
  const result = row.resultJson ? safeParse(row.resultJson, sessionResultSchema) : undefined;
  const question = row.pendingQuestionJson
    ? safeParse(row.pendingQuestionJson, pendingQuestionSchema)
    : undefined;
  const runtime = row.runtimeJson ? safeParseUntyped(row.runtimeJson) : {};
  return {
    id: row.id,
    organizationId: row.organizationId,
    wakeupId: row.wakeupId ?? undefined,
    agentId: row.agentId,
    adapter: row.adapter,
    // jsonObjectSchema accepts JsonValue-keyed maps; we trust the DB-stored JSON.
    runtime: runtime as never,
    prompt: row.prompt,
    status: row.status as SessionStatus,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    durationMs: row.durationMs ?? undefined,
    result,
    parentSessionId: row.parentSessionId ?? null,
    question,
    logRef: row.sessionId ?? undefined,
  };
}

function safeParse<T>(
  json: string | null,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
): T | undefined {
  if (!json) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(json));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function safeParseUntyped(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
