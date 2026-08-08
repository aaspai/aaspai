import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import { prepareConfigInjection, resolveOpenCodeConfig } from "../../config/index.js";
import { createOpenCodeAccumulator } from "../../protocol/accumulator.js";
import { decodeOpenCodeLine } from "../../protocol/decode.js";
import { opencodeSessionCodec } from "../../session/codec.js";
import {
  OPENCODE_COMPATIBILITY_VERSION,
  OpenCodeServerClient,
  OpenCodeServerError,
  type OpenCodeServerEvent,
} from "./client.js";
import { type ManagedOpenCodeServer, startManagedOpenCodeServer } from "./lifecycle.js";

interface RunningServerRun {
  sessionId: string;
  client: OpenCodeServerClient;
  abort: () => Promise<void>;
  done: Promise<AdapterExecutionResult>;
}

interface ManagedServerScope {
  managed: ManagedOpenCodeServer;
  references: number;
  idleTimer?: NodeJS.Timeout;
}

const running = new Map<string, RunningServerRun>();
const sessionClients = new Map<string, OpenCodeServerClient>();
const sessionScopes = new Map<string, string>();
const managedScopes = new Map<string, Promise<ManagedServerScope>>();
const MANAGED_SERVER_IDLE_MS = 30_000;

/** Production OpenCode adapter backed by `opencode serve` HTTP/SSE. */
export const opencodeServer: ServerAdapterModule = {
  info: {
    type: "opencode_local",
    label: "OpenCode (server)",
    transport: "local_subprocess",
    models: [],
    agentConfigurationDoc: "Prepared model/agent/MCP configuration is supplied by the caller.",
    status: "ready",
  },
  sessionCodec: opencodeSessionCodec,
  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const config = resolveOpenCodeConfig(ctx.config);
    if (config.transport !== "server") {
      throw new Error("OpenCode batch transport is not part of the production adapter");
    }
    let managed: ManagedOpenCodeServer | undefined;
    let managedScope: { key: string; scope: ManagedServerScope } | undefined;
    let configInjection: ReturnType<typeof prepareConfigInjection> | undefined;
    let client: OpenCodeServerClient;
    if (config.serverUrl) {
      client = new OpenCodeServerClient({
        baseUrl: config.serverUrl,
        username: config.serverUsername,
        password: config.serverPassword,
        expectedVersion: config.serverExpectedVersion ?? OPENCODE_COMPATIBILITY_VERSION,
      });
    } else if (ctx.execution.start) {
      const startExecution = ctx.execution.start;
      // The server receives only caller-prepared, secret-free configuration.
      // Credentials remain ephemeral environment values on the runtime
      // process; no adapter-owned auth/config store is touched.
      configInjection = prepareConfigInjection(config);
      managedScope = await acquireManagedServerScope({
        ctx,
        config,
        configEnv: configInjection.extraEnv,
        start: () =>
          startManagedOpenCodeServer({
            runtime: {
              startExecution: (request, hooks) => startExecution(request, hooks),
              exposeEndpoint: ctx.execution.exposeEndpoint
                ? (options) =>
                    ctx.execution.exposeEndpoint?.(options) as Promise<{
                      url: string;
                      headers?: Record<string, string>;
                      close?(): Promise<void>;
                    }>
                : undefined,
            },
            cwd: ctx.context.cwd,
            command: config.command,
            commandArgs: config.commandArgs,
            configEnv: configInjection?.extraEnv,
            expectedVersion: config.serverExpectedVersion ?? OPENCODE_COMPATIBILITY_VERSION,
            startupTimeoutMs: config.serverStartupTimeoutMs,
            ...(typeof config.port === "number" ? { port: config.port } : {}),
            exposeEndpoint: ctx.execution.exposeEndpoint
              ? (options) =>
                  ctx.execution.exposeEndpoint?.(options) as Promise<{
                    url: string;
                    headers?: Record<string, string>;
                    close?(): Promise<void>;
                  }>
              : undefined,
          }),
      });
      managed = managedScope.scope.managed;
      client = managed.client;
    } else {
      throw new Error("OpenCode server mode requires a prepared serverUrl or runtime.start()");
    }

    let resourcesReleased = false;
    const releaseResources = (): void => {
      if (resourcesReleased) return;
      resourcesReleased = true;
      releaseManagedServerScope(managedScope);
      configInjection?.cleanup();
    };
    let nativeSessionId: string;
    try {
      await client.health(ctx.signal);
      nativeSessionId = ctx.runtime.sessionId ?? "";
      if (nativeSessionId) {
        try {
          await client.getSession(nativeSessionId, ctx.signal);
        } catch (error) {
          if (!(error instanceof OpenCodeServerError) || error.status !== 404) throw error;
          nativeSessionId = "";
        }
      }
      nativeSessionId ||= (await client.createSession({ title: config.title }, ctx.signal)).id;
    } catch (error) {
      releaseResources();
      throw error;
    }
    sessionClients.set(nativeSessionId, client);
    if (managedScope) sessionScopes.set(nativeSessionId, managedScope.key);
    const accumulator = createOpenCodeAccumulator();
    const eventAbort = new AbortController();
    const startedAt = Date.now();
    let terminalStatus: "completed" | "failed" | "cancelled" | "timed_out" = "completed";
    let transportError: string | undefined;
    let terminalResolve!: () => void;
    let terminalReject!: (error: unknown) => void;
    let terminalObserved = false;
    const terminal = new Promise<void>((resolve, reject) => {
      terminalResolve = resolve;
      terminalReject = reject;
    });
    void terminal.catch(() => undefined);

    const consume = async (): Promise<void> => {
      let reconnectDeadline = Date.now() + 120_000;
      let retryDelayMs = 100;
      try {
        while (!eventAbort.signal.aborted && !terminalObserved) {
          for await (const event of client.events(eventAbort.signal)) {
            // A live event proves the transport is healthy. The two-minute
            // budget applies to an uninterrupted outage, not to a long turn.
            reconnectDeadline = Date.now() + 120_000;
            retryDelayMs = 100;
            const normalized = normalizeServerEvent(event);
            const sessionId = normalized.sessionID;
            if (sessionId && sessionId !== nativeSessionId) continue;
            if (event.type === "session.idle" || event.type === "session.completed") {
              terminalObserved = true;
              terminalResolve();
              return;
            }
            if (event.type === "session.error") {
              transportError = eventMessage(event) ?? "OpenCode session failed";
              terminalStatus = "failed";
              terminalObserved = true;
              terminalResolve();
              return;
            }
            if (event.type === "permission.asked") {
              const properties = event.properties ?? {};
              const permissionId = String(
                properties.requestID ?? properties.permissionID ?? properties.id ?? "",
              );
              const toolName = String(properties.permission ?? properties.tool ?? "permission");
              const decision =
                (await ctx.onPermission?.({
                  toolName,
                  description:
                    typeof properties.description === "string" ? properties.description : undefined,
                  input: properties,
                })) ?? "reject";
              if (permissionId && decision) {
                await client.respondPermission(nativeSessionId, permissionId, decision, ctx.signal);
              }
              continue;
            }
            if (event.type === "question.asked") {
              const properties = event.properties ?? {};
              const questions = Array.isArray(properties.questions)
                ? properties.questions
                : [properties];
              const answers: string[] = [];
              for (const question of questions) {
                const value =
                  question && typeof question === "object"
                    ? (question as Record<string, unknown>)
                    : {};
                const answer = await ctx.onQuestion?.({
                  prompt: String(value.prompt ?? value.question ?? "OpenCode question"),
                  options: Array.isArray(value.options)
                    ? value.options
                        .map((item) => {
                          if (typeof item === "string") return item;
                          if (item && typeof item === "object") {
                            const label = (item as Record<string, unknown>).label;
                            return typeof label === "string" ? label : undefined;
                          }
                          return undefined;
                        })
                        .filter((item): item is string => typeof item === "string")
                    : undefined,
                });
                if (answer !== undefined) answers.push(answer);
              }
              const questionId = String(
                properties.requestID ?? properties.id ?? properties.questionID ?? "",
              );
              if (questionId) {
                if (answers.length > 0)
                  await client.respondQuestion(
                    questionId,
                    answers.map((answer) => [answer]),
                    ctx.signal,
                  );
                else await client.rejectQuestion(questionId, ctx.signal);
              }
              continue;
            }
            // SSE is the authoritative native event stream for server mode.
            // Keep an untouched copy for observability; semantic consumers
            // receive the normalized HarnessEvent below.
            await ctx.onRawLog?.({
              stream: "stdout",
              chunk: `${JSON.stringify(event)}\n`,
              ts: new Date().toISOString(),
            });
            await applyServerEvent(normalized, accumulator, ctx);
          }
          if (eventAbort.signal.aborted || terminalObserved) return;
          if (Date.now() >= reconnectDeadline) {
            throw new Error("OpenCode SSE transport lost for more than two minutes");
          }
          // Reconcile the authoritative message list before reconnecting. The
          // reducer is identity-aware, so replayed parts do not duplicate
          // native tool or transcript events.
          const messages = await client.listMessages(nativeSessionId, 200, ctx.signal);
          for (const message of messages) {
            for (const part of message.parts ?? []) {
              await applyServerEvent(
                { type: "message.part.updated", sessionID: nativeSessionId, part },
                accumulator,
                ctx,
              );
            }
          }
          reconnectDeadline = Date.now() + 120_000;
          await delay(retryDelayMs + Math.floor(Math.random() * retryDelayMs), {
            signal: eventAbort.signal,
          }).catch(() => undefined);
          retryDelayMs = Math.min(2_000, retryDelayMs * 2);
        }
      } catch (error) {
        if (!eventAbort.signal.aborted) {
          transportError = error instanceof Error ? error.message : String(error);
          terminalStatus = "failed";
          terminalReject(error);
        }
      }
    };
    const consumeTask = consume();
    const abort = async (reason: "cancelled" | "timed_out" = "cancelled"): Promise<void> => {
      if (terminalObserved) return;
      terminalStatus = reason;
      await client.abort(nativeSessionId).catch(() => undefined);
      terminalObserved = true;
      terminalResolve();
      eventAbort.abort();
    };
    const done = (async (): Promise<AdapterExecutionResult> => {
      try {
        const model = parseModel(config.model);
        await client.promptAsync(
          nativeSessionId,
          {
            prompt: ctx.context.prompt,
            model,
            variant: config.variant,
            agent: config.agent,
            system: ctx.context.systemPrompt,
          },
          ctx.signal,
        );
        const externalAbort = (): void => void abort();
        if (ctx.signal?.aborted) externalAbort();
        else ctx.signal?.addEventListener("abort", externalAbort, { once: true });
        const timeout = setTimeout(
          () => {
            void abort("timed_out").finally(terminalResolve);
          },
          (config.timeoutSec ?? 86_400) * 1_000,
        );
        timeout.unref();
        try {
          await terminal;
        } finally {
          clearTimeout(timeout);
          ctx.signal?.removeEventListener("abort", externalAbort);
          eventAbort.abort();
        }
      } catch (error) {
        if (ctx.signal?.aborted) await abort("cancelled");
        terminalStatus = ctx.signal?.aborted ? "cancelled" : "failed";
        transportError = error instanceof Error ? error.message : String(error);
        terminalObserved = true;
        eventAbort.abort();
        terminalResolve();
      }
      await consumeTask.catch(() => undefined);
      const state = accumulator.result();
      const finishedAt = Date.now();
      const finalStatus = terminalStatus as "completed" | "failed" | "cancelled" | "timed_out";
      return {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        sessionId: nativeSessionId,
        sessionParams: { nativeSessionId, driver: "server" },
        exitCode: finalStatus === "completed" ? 0 : null,
        timedOut: finalStatus === "timed_out",
        status: finalStatus,
        errorMessage: transportError,
        errorCode:
          finalStatus === "timed_out"
            ? "timeout"
            : transportError
              ? "opencode_server_failed"
              : undefined,
        errorFamily:
          finalStatus === "timed_out"
            ? "transient_upstream"
            : transportError
              ? "internal"
              : undefined,
        usage: {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          cachedInputTokens: state.cachedInputTokens,
        },
        usageBasis: "per_run",
        costUsd: state.cost > 0 ? state.cost : undefined,
        provider: "opencode",
        biller: "opencode-server",
        billingType: "api",
        model: config.model,
        summary: state.text.slice(0, 8_192),
        clearSession: false,
        resultJson: {
          text: state.text,
          nativeSessionId,
          toolEvents: state.toolEvents,
          toolsInvoked: state.toolsInvoked,
        },
        runtimeServices: managed
          ? [{ name: "opencode", scope: "workspace", url: managed.endpoint, status: "ready" }]
          : undefined,
        ...(finishedAt < startedAt ? { errorMessage: "invalid server clock" } : {}),
      };
    })();
    const run: RunningServerRun = { sessionId: nativeSessionId, client, abort, done };
    running.set(ctx.runId, run);
    running.set(nativeSessionId, run);
    try {
      return await done;
    } finally {
      running.delete(ctx.runId);
      if (running.get(nativeSessionId) === run) running.delete(nativeSessionId);
      releaseResources();
    }
  },
  async testEnvironment(ctx) {
    const config = resolveOpenCodeConfig(ctx.config);
    if (!config.serverUrl)
      return {
        ok: false,
        checks: [
          { name: "server_url", level: "error", message: "serverUrl is required for server mode" },
        ],
      };
    try {
      const health = await new OpenCodeServerClient({
        baseUrl: config.serverUrl,
        username: config.serverUsername,
        password: config.serverPassword,
        expectedVersion: config.serverExpectedVersion ?? OPENCODE_COMPATIBILITY_VERSION,
      }).health();
      return {
        ok: true,
        checks: [
          { name: "server", level: "info", message: `OpenCode ${health.version} is healthy` },
        ],
      };
    } catch (error) {
      return {
        ok: false,
        checks: [
          {
            name: "server",
            level: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
  async cancel({ sessionId }) {
    const run = running.get(sessionId);
    if (!run) return { cancelled: false, sessionId, finalStatus: "already_finished" };
    await run.abort();
    return { cancelled: true, sessionId, finalStatus: "cancelled" };
  },
  async fork({ parentSessionId, fromStep }) {
    const client = running.get(parentSessionId)?.client ?? sessionClients.get(parentSessionId);
    if (!client) return { forked: false, parentSessionId };
    let messageId: string | undefined;
    if (fromStep !== undefined) {
      const messages = await client.listMessages(parentSessionId, 200);
      messageId = messages[fromStep]?.info?.id;
    }
    const forked = await client.fork(parentSessionId, messageId);
    return { forked: true, parentSessionId, childSessionId: forked.id };
  },
  describe() {
    return {
      type: "opencode_local",
      label: "OpenCode (server)",
      models: [],
      nativeTools: [],
      supportsCancel: true,
      supportsCompact: false,
      supportsFork: true,
      supportsResume: true,
      supportsThinking: true,
      supportsForkSession: false,
    };
  },
};

async function acquireManagedServerScope(options: {
  ctx: AdapterExecutionContext;
  config: ReturnType<typeof resolveOpenCodeConfig>;
  configEnv: Record<string, string>;
  start: () => Promise<ManagedOpenCodeServer>;
}): Promise<{ key: string; scope: ManagedServerScope }> {
  const key = managedScopeKey(options.ctx, options.config, options.configEnv);
  let pending = managedScopes.get(key);
  if (!pending) {
    pending = options.start().then((managed) => ({ managed, references: 0 }));
    managedScopes.set(key, pending);
    void pending.catch(() => {
      if (managedScopes.get(key) === pending) managedScopes.delete(key);
    });
  }
  const scope = await pending;
  scope.references += 1;
  if (scope.idleTimer) {
    clearTimeout(scope.idleTimer);
    scope.idleTimer = undefined;
  }
  return { key, scope };
}

function releaseManagedServerScope(
  handle: { key: string; scope: ManagedServerScope } | undefined,
): void {
  if (!handle) return;
  const { key, scope } = handle;
  scope.references = Math.max(0, scope.references - 1);
  if (scope.references !== 0 || scope.idleTimer) return;
  scope.idleTimer = setTimeout(() => {
    scope.idleTimer = undefined;
    if (scope.references !== 0 || managedScopes.get(key) === undefined) return;
    managedScopes.delete(key);
    for (const [sessionId, sessionKey] of sessionScopes) {
      if (sessionKey === key) {
        sessionScopes.delete(sessionId);
        sessionClients.delete(sessionId);
      }
    }
    void scope.managed.stop("opencode_scope_idle").catch(() => undefined);
  }, MANAGED_SERVER_IDLE_MS);
  scope.idleTimer.unref();
}

function managedScopeKey(
  ctx: AdapterExecutionContext,
  config: ReturnType<typeof resolveOpenCodeConfig>,
  configEnv: Record<string, string>,
): string {
  const identity = ctx.execution.identity ?? {};
  const scope =
    identity.runtimeScope ??
    identity.stateScope ??
    identity.scope ??
    identity.cwd ??
    ctx.context.cwd;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        command: config.command,
        commandArgs: config.commandArgs,
        cwd: ctx.context.cwd,
        expectedVersion: config.serverExpectedVersion ?? OPENCODE_COMPATIBILITY_VERSION,
        config: configEnv.OPENCODE_CONFIG_CONTENT ?? "",
      }),
    )
    .digest("hex");
  return `${String(identity.kind ?? "local")}:${String(scope)}:${fingerprint}`;
}

/** Stop idle servers during process shutdown/tests. */
export async function shutdownManagedOpenCodeServers(): Promise<void> {
  const pending = [...managedScopes.values()];
  managedScopes.clear();
  sessionScopes.clear();
  sessionClients.clear();
  const scopes = await Promise.allSettled(pending);
  await Promise.all(
    scopes
      .filter(
        (item): item is PromiseFulfilledResult<ManagedServerScope> => item.status === "fulfilled",
      )
      .map(async ({ value }) => {
        if (value.idleTimer) clearTimeout(value.idleTimer);
        value.references = 0;
        await value.managed.stop("opencode_scope_shutdown").catch(() => undefined);
      }),
  );
}

function parseModel(value: string): { providerID: string; modelID: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`OpenCode model must use provider/model syntax: ${value}`);
  }
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  };
}

function normalizeServerEvent(event: OpenCodeServerEvent): Record<string, unknown> {
  const properties = event.properties ?? {};
  const part = properties.part ?? properties;
  const type =
    event.type === "message.part.updated"
      ? part && typeof part === "object" && "type" in part
        ? String((part as { type?: unknown }).type) === "text"
          ? "text"
          : String((part as { type?: unknown }).type) === "reasoning"
            ? "reasoning"
            : String((part as { type?: unknown }).type) === "tool"
              ? "tool_use"
              : String((part as { type?: unknown }).type)
        : event.type
      : event.type;
  return {
    ...event,
    ...properties,
    type,
    ...(properties.sessionID || event.sessionID
      ? {}
      : properties.sessionId
        ? { sessionID: properties.sessionId }
        : event.sessionId
          ? { sessionID: event.sessionId }
          : {}),
    ...(part && typeof part === "object" ? { part } : {}),
  };
}

function eventMessage(event: OpenCodeServerEvent): string | undefined {
  const properties = event.properties ?? {};
  const message = properties.message ?? properties.error;
  return typeof message === "string" ? message : undefined;
}

async function applyServerEvent(
  normalized: Record<string, unknown>,
  accumulator: ReturnType<typeof createOpenCodeAccumulator>,
  ctx: AdapterExecutionContext,
): Promise<void> {
  const decoded = decodeOpenCodeLine(JSON.stringify(normalized));
  if (!decoded) return;
  const applied = accumulator.apply(decoded);
  // Server mode has a typed event boundary. Transcript/progress projections
  // are retained by the reducer for compatibility and diagnostics, but are
  // not re-serialized onto onLog or misclassified as runtime transfer
  // progress (which would duplicate semantic events after reconnects).
  void applied.transcript;
  void applied.progress;
  for (const semantic of applied.events) {
    await ctx.onEvent?.(semantic);
  }
}
