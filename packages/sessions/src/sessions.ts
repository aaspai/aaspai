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
import {
  type AdapterExecutionContext,
  HARNESS_PROTOCOL_VERSION,
  type HarnessEvent,
  type TranscriptEntry,
} from "@aaspai/contracts/harness";
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
import {
  executionTargetSchema,
  type RunProcessOptions,
  type RunProcessResult,
} from "@aaspai/contracts/runtime";
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
import {
  createLocalProviderFromConfig,
  type LocalProviderConfig,
  RuntimeController,
  type RuntimeLease,
} from "@aaspai/runtime";
import type { SkillRegistry } from "@aaspai/skills";
import { emitNativeLine, emitSessionProjection } from "@aaspai/telemetry";

const log = getLogger("sessions");

/**
 * Module-level pending-answer registry, keyed by session id. The
 * adapter's `onQuestion` handler parks a promise here; the answer
 * endpoint calls `Sessions.resume(id, answer)` (from a *different*
 * Sessions instance / HTTP request) which resolves it so the adapter
 * can continue. Lives at module scope so it survives across
 * instances — exactly like the DB.
 */
const pendingAnswers = new Map<string, (answer: string | undefined) => void>();

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
  /** A runtime boundary acquired by the execution layer. */
  runtimeExecution?: AdapterExecutionContext["execution"];
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
    if (!parsedTarget.success) {
      throw new Error("Invalid execution target");
    }
    if (parsedTarget.data.kind !== "local") {
      throw new Error(
        "Sessions no longer provisions remote runtimes; acquire a Runtime V2 lease in execution and pass runtimeExecution",
      );
    }

    // 2. Load knowledge (resolved against the agent's include/exclude)
    const knowledge = await this.knowledgeLoader.loadFor(agent);

    // 3. Resolve + materialize skills.
    //   - Look up each `req.skills[]` entry in the registry.
    //   - Build the prompt-inlined "## Skill: <name>" block for the
    //     native adapter context.
    //   - Materialize caller-owned skills under the session workspace. The
    //     production OpenCode server receives prepared configuration; it
    //     never owns global auth or skill state.
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
        sharedHome: false,
        symlink: false,
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
    let seq = await this.getNextSeq(sessionId);
    let observedToolCallCount = 0;
    let sessionEventPersistenceError: Error | undefined;
    const recordEvent = async (
      stream: "stdout" | "stderr",
      payload: JsonObject,
      kind: TranscriptEntry["kind"] | "question" | "user" | "compaction" | "snapshot",
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
      // Observer bridge: emit the normalized line to the telemetry store
      // (best-effort; never affects session outcome).
      if (kind === "tool_call") observedToolCallCount += 1;
      emitNativeLine({
        organizationId: req.organizationId,
        sessionId,
        model: agent.model,
        provider: "aaspai",
        stream,
        line: typeof payload.text === "string" ? payload.text : kind,
        ts: eventInsert.ts,
        kind,
        payload: payload as Record<string, unknown>,
        seq,
      });
    };

    // 5a. Build the full prompt. The native adapter receives the system
    // instructions and user prompt as one explicit request context.
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
    const cwd = req.cwd ?? process.cwd();
    // The harness contract requires an `execution` boundary on every
    // The execution layer may provide a leased Runtime V2 boundary. For
    // direct local sessions, create a short-lived Local provider lease; this
    // keeps the adapter from ever spawning a process on its own.
    let execution = this.opts.runtimeExecution;
    let localRuntime: RuntimeController<LocalProviderConfig> | undefined;
    let localLease: RuntimeLease | undefined;
    if (!execution) {
      const provider = await createLocalProviderFromConfig({ root: cwd });
      const runtime = new RuntimeController({ provider });
      const lease = await runtime.acquire({ root: cwd }, { localPath: cwd });
      localRuntime = runtime;
      localLease = lease;
      await runtime.realize({ root: cwd }, lease, { localPath: cwd });
      const start = async (options: RunProcessOptions) => {
        const handle = await runtime.start(
          { root: cwd },
          lease,
          {
            command: options.command,
            args: [...(options.args ?? [])],
            cwd: options.cwd ?? cwd,
            env: options.env,
            inheritEnv: options.inheritEnv,
            stdin: options.stdin,
            timeoutMs: options.timeoutMs,
            graceMs: options.graceMs,
          },
          {
            onStdout: async (chunk) =>
              await options.onLog?.("stdout", new TextDecoder().decode(chunk)),
            onStderr: async (chunk) =>
              await options.onLog?.("stderr", new TextDecoder().decode(chunk)),
          },
        );
        if (options.signal?.aborted) await handle.cancel("cancelled");
        else
          options.signal?.addEventListener("abort", () => void handle.cancel("cancelled"), {
            once: true,
          });
        await options.onSpawn?.({ pid: handle.identity.pid ?? 0 });
        return handle;
      };
      execution = {
        identity: { kind: "local", cwd },
        run: async (options) => toExecutionResult(await (await start(options)).wait(), cwd),
        start: async (options) => {
          const handle = await start(options);
          return {
            wait: async () => toExecutionResult(await handle.wait(), cwd),
            cancel: async (reason?: string) => handle.cancel(reason),
          };
        },
        exposeEndpoint: async ({ port, protocol }) =>
          runtime.exposeEndpoint({ root: cwd }, lease, port, protocol),
      };
    }
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
          protocolVersion: HARNESS_PROTOCOL_VERSION,
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
          execution,
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
          onEvent: async (event) => {
            for (const entry of sessionEventsForHarnessEvent(event)) {
              await recordEvent(entry.stream, entry.payload, entry.kind);
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
          onQuestion: async (question) => {
            // Interactive channel: record the question, flip the
            // session to paused_for_question, and park a promise that
            // the answer endpoint resolves via resume().
            await recordEvent("stdout", question as JsonObject, "question");
            await this.pause(sessionId, question.prompt, question.options);
            return new Promise<string | undefined>((resolve) => {
              pendingAnswers.set(sessionId, resolve);
            });
          },
        });
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

        // Reclassify the errorFamily on the success path too. A
        // non-throwing adapter can return `errorFamily: "internal"` for
        // every non-zero exit
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
        // Observer bridge: persist the session summary projection.
        emitSessionProjection({
          organizationId: req.organizationId,
          sessionId,
          provider: "aaspai",
          model: agent.model,
          status,
          messageCount: seq,
          toolCallCount: observedToolCallCount,
          logs: [],
          costUsd: result.costUsd,
        });
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
    } finally {
      // Every direct local session owns a short-lived lease. Release it here
      // even when the adapter throws or the caller returns early. A caller
      // supplied boundary remains owned by the execution layer.
      this.runningSessions.delete(sessionId);
      const pending = pendingAnswers.get(sessionId);
      if (pending) {
        pendingAnswers.delete(sessionId);
        pending(undefined);
      }
      if (localRuntime && localLease) {
        try {
          await localRuntime.release({ root: cwd }, localLease, "destroy");
        } catch (error) {
          log.warn("failed to release direct local runtime lease", {
            sessionId,
            error: String(error),
          });
        }
      }
    }
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

  async pause(id: string, reason: string, options?: readonly string[]): Promise<void> {
    const db = getDefaultDb();
    await db.db
      .update(sessionsTable)
      .set({
        status: "paused_for_question",
        pendingQuestionJson: JSON.stringify({
          prompt: reason,
          ...(options && options.length > 0 ? { options } : {}),
          askedAt: new Date().toISOString(),
        }),
      } as never)
      .where(eqId(sessionsTable.id, id));
    log.info("session paused", { id, reason });
  }

  async resume(id: string, answer?: string): Promise<SessionResult | null> {
    const db = getDefaultDb();
    // Resolve the in-flight onQuestion promise (if any) so the parked
    // adapter call continues with the user's answer.
    const resolve = pendingAnswers.get(id);
    if (resolve) {
      pendingAnswers.delete(id);
      resolve(answer);
    }
    // Record the answer as a user-kind session event so it shows in
    // the transcript between the question and the resumption.
    if (answer && answer.trim().length > 0) {
      try {
        await this.recordEvent(id, "user", { text: answer });
      } catch (err) {
        log.warn("failed to record answer event", { id, err: String(err) });
      }
    }
    await db.db
      .update(sessionsTable)
      .set({ status: "running", pendingQuestionJson: null } as never)
      // Only flip paused → running; if the run already reached a
      // terminal status (succeeded/failed/timed_out) the completion
      // update wins and we must not clobber it.
      .where(and(eqId(sessionsTable.id, id), eq(sessionsTable.status, "paused_for_question")));
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
    const adapter = live?.adapter ?? getAdapter("opencode_local" as AdapterType);
    let result: {
      compacted: boolean;
      sessionId: string;
      tokensBefore?: number;
      tokensAfter?: number;
      summary?: string;
    };
    if (typeof adapter.compact === "function") {
      result = await adapter.compact({
        sessionId,
        force: opts.force ?? false,
        tailTurns: opts.tailTurns,
      });
    } else {
      log.warn("adapter.compact not implemented", { sessionId, adapter: "unknown" });
      result = { compacted: false, sessionId, summary: "adapter.compact not implemented" };
    }
    // Record a session event for the audit trail — even when the
    // adapter doesn't implement compact, the attempt is still audited.
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

import { and, eq } from "drizzle-orm";

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

type SessionHarnessEvent = {
  stream: "stdout" | "stderr";
  kind: TranscriptEntry["kind"];
  payload: JsonObject;
};

/** Project typed Harness V2 events into the durable session transcript. */
function sessionEventsForHarnessEvent(event: HarnessEvent): SessionHarnessEvent[] {
  const native: JsonObject = event.nativeSessionId
    ? { nativeSessionId: event.nativeSessionId }
    : {};
  switch (event.type) {
    case "run.started":
      return [
        {
          stream: "stdout",
          kind: "init",
          payload: {
            ...native,
            ...(event.model ? { model: event.model } : {}),
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          },
        },
      ];
    case "native.session":
      return [
        {
          stream: "stdout",
          kind: "init",
          payload: { ...native, sessionId: event.nativeSessionId },
        },
      ];
    case "assistant.delta":
      return [{ stream: "stdout", kind: "assistant", payload: { ...native, text: event.text } }];
    case "reasoning.delta":
      return [{ stream: "stdout", kind: "thinking", payload: { ...native, text: event.text } }];
    case "tool.started":
      return [
        {
          stream: "stdout",
          kind: "tool_call",
          payload: {
            ...native,
            name: event.toolName,
            status: "started",
            ...(event.toolCallId ? { id: event.toolCallId } : {}),
            ...(asJsonObject(event.input) ? { input: asJsonObject(event.input) } : {}),
          },
        },
      ];
    case "tool.completed":
      return [
        {
          stream: "stdout",
          kind: "tool_call",
          payload: {
            ...native,
            name: event.toolName,
            status: "completed",
            ...(event.toolCallId ? { id: event.toolCallId } : {}),
            ...(asJsonObject(event.input) ? { input: asJsonObject(event.input) } : {}),
          },
        },
        {
          stream: "stdout",
          kind: "tool_result",
          payload: {
            ...native,
            name: event.toolName,
            ...(event.toolCallId ? { id: event.toolCallId } : {}),
            ...(event.output !== undefined ? { output: stringifyEventValue(event.output) } : {}),
          },
        },
      ];
    case "tool.failed":
      return [
        {
          stream: "stderr",
          kind: "tool_result",
          payload: {
            ...native,
            name: event.toolName,
            isError: true,
            ...(event.toolCallId ? { id: event.toolCallId } : {}),
            ...(event.output !== undefined
              ? { output: stringifyEventValue(event.output) }
              : event.errorMessage
                ? { output: event.errorMessage }
                : {}),
          },
        },
      ];
    case "step.completed":
      return [
        {
          stream: "stdout",
          kind: "result",
          payload: { ...native, stopReason: "step_completed" },
        },
      ];
    case "run.completed":
      return [
        {
          stream: "stdout",
          kind: "result",
          payload: { ...native, stopReason: event.status },
        },
      ];
    case "error":
      return [{ stream: "stderr", kind: "stderr", payload: { ...native, text: event.message } }];
    case "warning":
      return [{ stream: "stderr", kind: "system", payload: { ...native, text: event.message } }];
    case "usage":
    case "step.started":
      return [];
  }
}

function asJsonObject(value: unknown): JsonObject | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return undefined;
}

function stringifyEventValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toExecutionResult(
  result: import("@aaspai/runtime").RuntimeExecutionResult,
  cwd = process.cwd(),
): RunProcessResult {
  const decode = (value: Uint8Array | undefined): string =>
    value ? new TextDecoder().decode(value) : "";
  return {
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    timedOut: result.status === "timed_out",
    stdout: decode(result.stdoutTail),
    stderr: decode(result.stderrTail),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    ...(result.identity.pid ? { pid: result.identity.pid } : {}),
    runtimeIdentity: {
      kind: "local",
      cwd,
      pid: result.identity.pid,
    },
  };
}
