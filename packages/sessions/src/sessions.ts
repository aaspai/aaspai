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
import type { Skill } from "@aaspai/contracts/phase2";
import {
  type AgentConfigSource,
  type KnowledgeSource,
  pendingQuestionSchema,
  type SessionRequest,
  type SessionResult,
  type SessionState,
  type SessionStatus,
  sessionResultSchema,
} from "@aaspai/contracts/phase2";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { type ExecutionTarget, executionTargetSchema } from "@aaspai/contracts/runtime";
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

export function agentAdapterConfig(agent: {
  model?: string;
  adapterConfig: JsonObject;
}): JsonObject {
  return {
    ...(agent.model ? { model: agent.model } : {}),
    ...agent.adapterConfig,
  };
}

export interface SessionsOptions {
  agentSource: AgentConfigSource;
  knowledgeSource: KnowledgeSource;
  skillRegistry: SkillRegistry;
}

export class Sessions {
  private readonly knowledgeLoader: KnowledgeLoader;
  private started = false;
  /** Map of sessionId -> abort signal for out-of-band cancel. */
  private readonly runningSessions = new Map<
    string,
    { controller: AbortController; adapter: ReturnType<typeof getAdapter> }
  >();

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
    const adapterConfig = agentAdapterConfig(agent);
    const executionConfig = { ...adapterConfig, ...(req.config ?? {}) };
    const parsedTarget = executionTargetSchema.safeParse(req.runtime);
    const runtimeTarget = parsedTarget.success
      ? (await import("@aaspai/runtime")).resolveTarget(parsedTarget.data)
      : undefined;
    if (runtimeTarget?.readiness && parsedTarget.success) {
      const ready = await runtimeTarget.readiness(parsedTarget.data);
      if (!ready.ready) throw new Error(ready.reason ?? "Execution runtime is not ready");
    }

    // 2. Load knowledge (resolved against the agent's include/exclude)
    const knowledge = await this.knowledgeLoader.loadFor(agent);

    // 3. Resolve + materialize skills.
    //   - Look up each `req.skills[]` entry in the registry.
    //   - Build the prompt-inlined "## Skill: <name>" block (used by
    //     adapters that don't read SKILL.md from disk, e.g. dry-run).
    //   - Materialize the same skills to the adapter's runtime dir
    //     so the opencode CLI / claude CLI can discover them as
    //     files. For the opencode CLI we use the shared
    //     `~/.claude/skills` home (the opencode CLI's default).
    const skillInstructions: string[] = [];
    const resolvedSkills: Skill[] = [];
    for (const ref of req.skills) {
      const skill = this.opts.skillRegistry.get(ref.key, ref.version);
      if (skill) {
        skillInstructions.push(`## Skill: ${skill.name}\n\n${skill.instructions}`);
        resolvedSkills.push(skill);
      } else {
        log.warn("skill not found in registry", { key: ref.key, version: ref.version });
      }
    }
    if (resolvedSkills.length > 0) {
      const materialization = await this.opts.skillRegistry.materialize(resolvedSkills, {
        adapterType: req.adapter,
        runtimeBaseDir: req.cwd ?? process.cwd(),
        sharedHome: req.adapter === "opencode_cli" || req.adapter === "claude_local",
        symlink: req.adapter === "opencode_cli",
        verifySha256: true,
      });
      if (materialization.errors.length > 0) {
        log.warn("skill materialization errors", {
          errors: materialization.errors,
          adapter: req.adapter,
        });
      }
    }

    // 4. Build the session record
    const sessionId = req.durableSessionId ?? `sess_${randomUUID()}`;
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
        ...executionConfig,
        agentConfig: { id: agent.id, adapter: agent.adapter, model: agent.model },
      }),
      status: "running",
      sessionDisplayId: sessionId.slice(0, 8),
      startedAt: now,
      parentSessionId: req.parentSessionId ?? null,
    };
    const db = getDefaultDb();
    const existing = req.durableSessionId
      ? (
          await db.db.select().from(sessionsTable).where(eqId(sessionsTable.id, sessionId)).limit(1)
        )[0]
      : undefined;
    if (
      existing &&
      (existing.organizationId !== req.organizationId ||
        existing.wakeupId !== (req.wakeupId ?? "manual"))
    ) {
      throw new Error(`Durable session ${sessionId} belongs to another request`);
    }
    if (existing) {
      await db.db
        .update(sessionsTable)
        .set({ ...insert, id: undefined } as never)
        .where(eqId(sessionsTable.id, sessionId));
    } else {
      await db.db
        .insert(sessionsTable)
        .values({ ...insert, wakeupId: insert.wakeupId ?? "manual" } as never);
    }

    // 5. Resolve the adapter and run the session
    const adapter = getAdapter(req.adapter as AdapterType);
    // Tier 4: out-of-band cancel support. Register an AbortController
    // so Sessions.cancel(id) can stop a live child via signal abort.
    const controller = new AbortController();
    this.runningSessions.set(sessionId, { controller, adapter });
    let seq = 0;
    let sessionEventPersistenceError: Error | undefined;
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
        sessionEventPersistenceError = err instanceof Error ? err : new Error(String(err));
        log.warn("failed to record session event", { sessionId, seq, err: String(err) });
      }
    };

    // 5a. Build the full prompt — the dry-run adapter reads the system
    // prompt from context, real adapters just see a bigger prompt.
    const knowledgeBlock = knowledge.context ? `\n\n---\n\n${knowledge.context}\n` : "";
    const systemBlock =
      agent.systemPrompt.trim().length > 0 ? `${agent.systemPrompt.trim()}\n\n---\n\n` : "";
    const cliBlock = process.env.AASPAI_CLI_PATH
      ? `Current aaspai CLI command: ${JSON.stringify(process.execPath)} ${JSON.stringify(process.env.AASPAI_CLI_PATH)}. Use this exact entry point for nested aaspai commands; do not call another global installation.\n\n---\n\n`
      : "";
    const skillsBlock =
      skillInstructions.length > 0 ? `${skillInstructions.join("\n\n")}\n\n---\n\n` : "";
    // Wake-up delta (Priority 7): when resuming, prepend the
    // resume.context (if any) to the prompt so the agent sees the
    // user's intervening messages. Prepended BEFORE the user
    // prompt so the model treats it as background, not the new ask.
    const wakeupContextBlock = req.resume?.context
      ? `## Wakeup context\n\n${req.resume.context}\n\n---\n\n`
      : "";
    const fullPrompt = `${systemBlock}${cliBlock}${skillsBlock}${wakeupContextBlock}${req.prompt}${knowledgeBlock}`;

    let result: SessionResult | undefined;
    const startedAtMs = Date.now();
    // Tier 4: retry policy for `transient_upstream` errors. Default:
    // 0 retries (caller opts in via `req.config.retry.transientMaxAttempts`).
    const retryConfig = (req.config?.retry as
      | { transientMaxAttempts?: number; transientBackoffMs?: number }
      | undefined) ?? { transientMaxAttempts: 0, transientBackoffMs: 500 };
    let attempt = 0;
    let shouldRetryFromCatch = false;
    let didComplete = false;
    try {
      // Retry loop — at most retryConfig.transientMaxAttempts extra calls.
      let adapterResult: Awaited<ReturnType<typeof adapter.execute>>;
      while (!didComplete && !shouldRetryFromCatch) {
        shouldRetryFromCatch = false; // reset for the next attempt
        attempt += 1;
        adapterResult = await adapter.execute({
          protocolVersion: 1 as const,
          runId: sessionId,
          organizationId: req.organizationId,
          agent: {
            id: agent.id,
            organizationId: req.organizationId,
            name: agent.title,
            adapterType: agent.adapter as AdapterType,
            adapterConfig,
          },
          runtime: {
            sessionId: req.resume?.sessionId,
            sessionParams: req.resume?.sessionParams,
            sessionDisplayId: undefined,
            taskKey: undefined,
          },
          config: executionConfig,
          context: {
            cwd: req.cwd ?? process.cwd(),
            prompt: fullPrompt,
            role: agent.role,
          },
          ...(runtimeTarget && parsedTarget.success
            ? {
                execution: {
                  identity: {
                    kind: parsedTarget.data.kind,
                    cwd:
                      parsedTarget.data.kind === "ssh"
                        ? parsedTarget.data.remoteCwd
                        : (req.cwd ?? process.cwd()),
                  },
                  run: (options: Parameters<NonNullable<typeof runtimeTarget.run>>[1]) =>
                    runtimeTarget.run(
                      {
                        ...parsedTarget.data,
                        ...(parsedTarget.data.kind === "local" ||
                        parsedTarget.data.kind === "docker"
                          ? { cwd: req.cwd ?? process.cwd() }
                          : {}),
                      } as ExecutionTarget,
                      { ...options, cwd: req.cwd ?? process.cwd() },
                    ),
                },
              }
            : {}),
          signal: controller.signal,
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
        if (runtimeTarget && parsedTarget.success) {
          adapterResult = {
            ...adapterResult,
            runtimeIdentity: {
              kind: parsedTarget.data.kind,
              cwd:
                parsedTarget.data.kind === "ssh"
                  ? parsedTarget.data.remoteCwd
                  : (req.cwd ?? process.cwd()),
            },
          };
        }

        const finishedAt = new Date().toISOString();
        const durationMs = Date.now() - startedAtMs;
        let status: SessionStatus = controller.signal.aborted
          ? "cancelled"
          : adapterResult.timedOut
            ? "timed_out"
            : adapterResult.exitCode === 0
              ? "succeeded"
              : "failed";
        if (sessionEventPersistenceError) status = "failed";

        // Reclassify the errorFamily on the success path too. The
        // opencode-cli adapter (and any other non-throwing adapter)
        // returns `errorFamily: "internal"` for every non-zero exit
        // regardless of the underlying cause. We look at the
        // adapter's errorMessage + the result's errorCode and
        // upgrade "internal" → "auth" / "provider_quota" /
        // "transient_upstream" when the keywords match. This is the
        // mirror of the catch-path classification below.
        const classifiedFamily =
          status === "failed"
            ? classifyErrorFamily(
                adapterResult.errorFamily,
                adapterResult.errorMessage,
                adapterResult.errorCode,
              )
            : adapterResult.errorFamily;

        // Budget enforcement (Priority 8): if the caller passed a
        // `budget: { perRun: { tokens, costUsd, durationMs } }` and
        // the run exceeded any hard limit, mark it failed with
        // errorFamily="user_cancelled" so the UI can surface a
        // "budget exceeded" banner. We don't kill the run — the
        // adapter already produced output — we just label it
        // post-hoc.
        const budgetViolation = checkBudgetViolation(req.budget, {
          tokens:
            (adapterResult.usage?.inputTokens ?? 0) + (adapterResult.usage?.outputTokens ?? 0),
          costUsd: adapterResult.costUsd ?? 0,
          durationMs,
        });
        if (budgetViolation) {
          status = "failed";
        }

        // Handoff markdown (Priority 7): if the caller passed a
        // handoffMarkdown, append it to the assistant's text in the
        // persisted summary so the next session (or a human) sees
        // the handoff note at the end of the run.
        const summaryBase =
          adapterResult.summary || adapterResult.errorMessage || adapterResult.errorCode || "";
        const finalSummary = req.handoffMarkdown
          ? summaryBase
            ? `${summaryBase}\n\n---\n\n${req.handoffMarkdown}`
            : req.handoffMarkdown
          : summaryBase;

        result = {
          sessionId: adapterResult.sessionId ?? sessionId,
          sessionDisplayId: adapterResult.sessionDisplayId,
          sessionParams: adapterResult.sessionParams,
          status,
          exitCode: adapterResult.exitCode,
          usage: adapterResult.usage,
          costUsd: adapterResult.costUsd,
          errorFamily:
            budgetViolation || status === "cancelled" ? "user_cancelled" : classifiedFamily,
          errorCode: budgetViolation
            ? `budget_exceeded:${budgetViolation.field}`
            : sessionEventPersistenceError
              ? "evidence_persistence_failed"
              : adapterResult.errorCode,
          // Summary is the assistant's text (if any), falling back
          // to the adapter's errorMessage for failed runs (where
          // the assistant text is typically empty). Handoff markdown
          // is appended here on success. The persisted
          // errorMessage column uses a different fallback chain —
          // see the update below.
          summary: finalSummary,
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
            // Persisted errorMessage column preference:
            //   1. adapter's errorMessage (the actual reason the run
            //      failed — sourced from stderr or the JSON error
            //      event by the adapter)
            //   2. result.summary (the assistant's text — usually
            //      empty for failures)
            //   3. result.errorCode (a stable string identifier)
            //   4. the literal "failed" so the column is never NULL
            // Only set for actual failures — successful sessions
            // leave the column NULL.
            errorMessage:
              status === "succeeded"
                ? undefined
                : budgetViolation
                  ? `Budget exceeded: ${budgetViolation.field} (limit ${budgetViolation.limit}, actual ${budgetViolation.actual})`
                  : sessionEventPersistenceError
                    ? sessionEventPersistenceError.message
                    : adapterResult.errorMessage || result.summary || result.errorCode || "failed",
          } as never)
          .where(eqId(sessionsTable.id, sessionId));
        log.info("session completed", { sessionId, status, durationMs, agent: agent.id });
        // Tier 4: retry-on-transient decision. We retry if the run
        // failed with errorFamily="transient_upstream" AND we have
        // attempts left AND the budget was NOT exceeded (don't retry
        // a budget burn).
        const maxAttempts = (retryConfig.transientMaxAttempts ?? 0) + 1;
        if (
          status === "failed" &&
          classifiedFamily === "transient_upstream" &&
          !budgetViolation &&
          attempt < maxAttempts
        ) {
          const backoff = retryConfig.transientBackoffMs ?? 500;
          log.info("retrying after transient_upstream", {
            sessionId,
            attempt,
            maxAttempts,
            backoffMs: backoff,
          });
          await new Promise((r) => setTimeout(r, backoff));
          continue; // <- inside the while loop, runs the next attempt
        }
        didComplete = true;
        return result;
      }
    } catch (err) {
      // Tier 4: also retry when the adapter throws a transient-shaped
      // error (network, ETIMEDOUT, ECONNRESET, etc.) — classified by
      // the catch-path classifier. We can't `continue` from a catch
      // (the while loop is outside the try), so we set a flag and
      // the while loop's condition checks it.
      const errMessage = (err as Error).message ?? "";
      const family = classifyErrorFamily(undefined, errMessage, "adapter_execution_failed");
      if (
        family === "transient_upstream" &&
        attempt < (retryConfig.transientMaxAttempts ?? 0) + 1
      ) {
        const backoff = retryConfig.transientBackoffMs ?? 500;
        log.info("retrying adapter throw after transient_upstream", {
          sessionId,
          attempt,
          err: errMessage,
          backoffMs: backoff,
        });
        await new Promise((r) => setTimeout(r, backoff));
        shouldRetryFromCatch = true;
        // Fall through to the closing `}` of the catch, which leads
        // back to the while-loop condition check below.
      } else {
        const finishedAt = new Date().toISOString();
        const durationMs = Date.now() - startedAtMs;
        const errMessage = (err as Error).message ?? "";
        const errorFamily = classifyErrorFamily(undefined, errMessage, "adapter_execution_failed");
        result = {
          sessionId,
          status: "failed",
          exitCode: 1,
          errorCode: "adapter_execution_failed",
          errorFamily,
          summary: errMessage,
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
        didComplete = true;
        return result;
      }
    }
    // Tier 4: unregister from runningSessions on completion.
    this.runningSessions.delete(sessionId);
    if (!result) throw new Error(`session ${sessionId} completed without a result`);
    return result;
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
    // Tier 4 (this pass): out-of-band cancel. If we have a live
    // AbortController for this session, abort it (the adapter's
    // signal handler will fire SIGTERM). Then ask the adapter
    // directly (covers attached-sessions and CLI-not-spawned cases).
    // Then record the cancellation in the DB.
    const live = this.runningSessions.get(id);
    if (live) {
      try {
        live.controller.abort();
      } catch {
        /* ignore */
      }
      try {
        if (typeof live.adapter.cancel === "function") {
          await live.adapter.cancel({ sessionId: id, reason });
        }
      } catch (err) {
        log.warn("adapter.cancel threw", { id, err: String(err) });
      }
      this.runningSessions.delete(id);
    }
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

  /**
   * Tier 4: compact a session. Calls adapter.compact() if the
   * adapter implements it; records a `compaction` event in the
   * session_events table for audit. Returns the adapter's result
   * or a fallback "not supported" response.
   */
  async compact(
    sessionId: string,
    opts: { tailTurns?: number; force?: boolean } = {},
  ): Promise<{
    compacted: boolean;
    sessionId: string;
    tokensBefore?: number;
    tokensAfter?: number;
    summary?: string;
  }> {
    const live = this.runningSessions.get(sessionId);
    const adapter = live?.adapter ?? getAdapter("opencode_cli" as AdapterType);
    if (typeof adapter.compact !== "function") {
      log.warn("adapter.compact not implemented", { sessionId, adapter: "unknown" });
      return { compacted: false, sessionId, summary: "adapter.compact not implemented" };
    }
    const result = await adapter.compact({
      sessionId,
      force: opts.force ?? false,
      tailTurns: opts.tailTurns,
    });
    // Record a session event for the audit trail.
    try {
      const db = getDefaultDb();
      const seq = (await this.getNextSeq(sessionId)) + 1;
      await db.db.insert(sessionEventsTable).values({
        sessionId,
        ts: new Date().toISOString(),
        kind: "compaction",
        payloadJson: JSON.stringify({
          tailTurns: opts.tailTurns,
          force: opts.force,
          result,
        }),
        seq,
      } as never);
    } catch (err) {
      log.warn("failed to record compaction event", { sessionId, err: String(err) });
    }
    return result;
  }

  /**
   * Tier 4: fork a session. Creates a new session row, then
   * re-executes with `Config.forkSession: true` and
   * `runtime.sessionId = parentSessionId`. The new session is
   * linked via `parentSessionId`.
   */
  async fork(parentSessionId: string, req: SessionRequest): Promise<SessionResult> {
    const forkReq: SessionRequest = {
      ...req,
      resume: { sessionId: parentSessionId, ...(req.resume ?? {}) },
      parentSessionId: req.idempotencyKey ? `${parentSessionId}#fork` : parentSessionId,
      config: { ...(req.config ?? {}), forkSession: true },
    };
    return this.execute(forkReq);
  }

  /**
   * Tier 4: helper to record arbitrary session events. Useful for
   * audit events (e.g. "compaction requested", "snapshot captured",
   * "fork created") that aren't tied to a specific adapter stream.
   */
  async recordEvent(
    sessionId: string,
    kind: TranscriptEntry["kind"],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const db = getDefaultDb();
    const seq = (await this.getNextSeq(sessionId)) + 1;
    await db.db.insert(sessionEventsTable).values({
      sessionId,
      ts: new Date().toISOString(),
      kind,
      payloadJson: JSON.stringify(payload),
      seq,
    } as never);
  }

  /** Return the next sequence number for a session's events. */
  private async getNextSeq(sessionId: string): Promise<number> {
    const db = getDefaultDb();
    const rows = await db.db
      .select({ seq: sessionEventsTable.seq })
      .from(sessionEventsTable)
      .where(eqId(sessionEventsTable.sessionId, sessionId))
      .orderBy(sessionEventsTable.seq);
    return rows[rows.length - 1]?.seq ?? 0;
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

/**
 * Check a run's actual usage against a `Budget` (the same shape as
 * `Budget.perRun` in `@aaspai/contracts/phase2`). Returns null if
 * within budget, or a violation descriptor if any hard limit is
 * exceeded. Soft limits are NOT enforced here — they're advisory
 * for the UI to surface a warning.
 *
 * Fields: `tokens`, `costUsd`, `durationMs`. A value of 0 (or
 * undefined) means "no limit for this field".
 */
function checkBudgetViolation(
  budgetRaw: unknown,
  actual: { tokens: number; costUsd: number; durationMs: number },
): { field: "tokens" | "costUsd" | "durationMs"; limit: number; actual: number } | null {
  const b = (
    budgetRaw as { perRun?: { tokens?: number; costUsd?: number; durationMs?: number } } | undefined
  )?.perRun;
  if (!b) return null;
  if (b.tokens && b.tokens > 0 && actual.tokens > b.tokens) {
    return { field: "tokens", limit: b.tokens, actual: actual.tokens };
  }
  if (b.costUsd && b.costUsd > 0 && actual.costUsd > b.costUsd) {
    return { field: "costUsd", limit: b.costUsd, actual: actual.costUsd };
  }
  if (b.durationMs && b.durationMs > 0 && actual.durationMs > b.durationMs) {
    return { field: "durationMs", limit: b.durationMs, actual: actual.durationMs };
  }
  return null;
}

/**
 * Classify an error into one of the `SessionResult["errorFamily"]`
 * buckets using the available signals.
 *
 * Source-of-truth preference order:
 *   1. `errorFamily` if the adapter already set one AND it isn't the
 *      "I don't know" fallback of `internal` (in which case we
 *      override using the message).
 *   2. Keyword match against the message text:
 *        - `auth|api key|unauthor` → "auth"
 *        - `quota|rate limit`        → "provider_quota"
 *        - `timeout|timed out`      → "transient_upstream"
 *   3. `errorCode` hints:
 *        - `killed_by_signal|timeout` → "transient_upstream"
 *   4. Default `internal`.
 *
 * Used by both the catch path (where the only signal is the thrown
 * error's message) and the success path (where the adapter has
 * already populated `errorMessage`, `errorCode`, and possibly
 * `errorFamily`).
 */
function classifyErrorFamily(
  adapterErrorFamily: SessionResult["errorFamily"] | undefined,
  message: string | undefined,
  errorCode: string | undefined,
): SessionResult["errorFamily"] {
  const m = (message ?? "").toLowerCase();
  if (/auth|api key|unauthor/i.test(m)) return "auth";
  if (/quota|rate limit/i.test(m)) return "provider_quota";
  if (/timeout|timed out|killed by sigterm|killed by sigkill/i.test(m)) return "transient_upstream";
  if (errorCode === "killed_by_signal" || errorCode === "timeout") return "transient_upstream";
  // Trust the adapter's classification when it isn't the default
  // "I don't know" answer.
  if (adapterErrorFamily && adapterErrorFamily !== "internal") return adapterErrorFamily;
  return "internal";
}
