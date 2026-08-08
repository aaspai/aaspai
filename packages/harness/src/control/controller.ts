import { randomUUID } from "node:crypto";
import {
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  HARNESS_PROTOCOL_VERSION,
  type HarnessEvent,
  type RawLogEntry,
  type ServerAdapterModule,
} from "@aaspai/contracts/harness";
export type HarnessExecutionState =
  | "created"
  | "starting"
  | "running"
  | "waiting_for_question"
  | "waiting_for_interaction"
  | "recovering"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost";

export interface HarnessQuestion {
  prompt: string;
  options?: string[];
}

export interface HarnessExecutionSnapshot {
  version?: 1;
  revision?: number;
  executionId: string;
  state: HarnessExecutionState;
  createdAt?: string;
  updatedAt?: string;
  providerSessionId?: string;
  question?: HarnessQuestion;
  result?: AdapterExecutionResult;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  cancelReason?: string;
  pendingInteractions?: Record<string, HarnessInteractionSnapshot>;
}

export type HarnessInteractionSnapshot =
  | { id: string; kind: "question"; question: HarnessQuestion; createdAt: string }
  | {
      id: string;
      kind: "permission";
      permission: { toolName: string; description?: string; input?: unknown };
      createdAt: string;
    };

export type HarnessControlEvent =
  | { type: "state.changed"; snapshot: HarnessExecutionSnapshot }
  | { type: "provider.event"; event: HarnessEvent }
  | { type: "raw.log"; entry: RawLogEntry }
  | { type: "question"; question: HarnessQuestion }
  | { type: "permission"; permission: { toolName: string; description?: string; input?: unknown } }
  | { type: "result"; result: AdapterExecutionResult }
  | { type: "error"; message: string };

export interface HarnessControlEventRecord {
  sequence: number;
  timestamp: string;
  event: HarnessControlEvent;
}

export interface HarnessControllerStore {
  save(snapshot: HarnessExecutionSnapshot): Promise<void> | void;
  append(executionId: string, event: HarnessControlEvent): Promise<void> | void;
  /** Atomically append an event and persist the snapshot at its revision. */
  compareAndAppend?(
    executionId: string,
    expectedRevision: number,
    event: HarnessControlEvent,
    snapshot: HarnessExecutionSnapshot,
  ): Promise<boolean> | boolean;
  appendAndSave?(
    executionId: string,
    event: HarnessControlEvent,
    snapshot: HarnessExecutionSnapshot,
  ): Promise<void> | void;
}

const NOOP_STORE: HarnessControllerStore = {
  save: () => undefined,
  append: () => undefined,
};

export interface HarnessControllerRequest {
  adapter: ServerAdapterModule;
  context: AdapterExecutionContext;
  executionId?: string;
}

export interface HarnessExecutionHandle {
  readonly executionId: string;
  readonly done: Promise<AdapterExecutionResult>;
  snapshot(): HarnessExecutionSnapshot;
  subscribe(listener: (event: HarnessControlEvent) => unknown): () => void;
  replay(fromSequence?: number): HarnessControlEventRecord[];
  cancel(reason?: string): Promise<boolean>;
  answerQuestion(answer: string): boolean;
  respondInteraction(id: string, response: HarnessInteractionResponse): boolean;
}

type HarnessInteractionResponse =
  | { kind: "question"; answer: string }
  | { kind: "permission"; response: "once" | "always" | "reject" };

interface PendingInteraction {
  snapshot: HarnessInteractionSnapshot;
  resolve: (response: HarnessInteractionResponse | undefined) => void;
}

interface RunRecord {
  adapter: ServerAdapterModule;
  abortController: AbortController;
  context: AdapterExecutionContext;
  listeners: Set<(event: HarnessControlEvent) => unknown>;
  pendingInteractions: Map<string, PendingInteraction>;
  questionHandler?: AdapterExecutionContext["onQuestion"];
  permissionHandler?: AdapterExecutionContext["onPermission"];
  resolvedInteractions: Set<string>;
  snapshot: HarnessExecutionSnapshot;
  history: HarnessControlEventRecord[];
  nextSequence: number;
  transitionTail: Promise<void>;
  journalFailure?: Error;
  disposalTimer?: NodeJS.Timeout;
}

function terminal(state: HarnessExecutionState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "timed_out" ||
    state === "lost"
  );
}

const ALLOWED_TRANSITIONS: Record<HarnessExecutionState, readonly HarnessExecutionState[]> = {
  created: ["starting", "recovering", "cancelling", "cancelled", "failed"],
  starting: ["running", "recovering", "cancelling", "failed", "cancelled"],
  running: [
    "waiting_for_question",
    "waiting_for_interaction",
    "cancelling",
    "recovering",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ],
  waiting_for_question: [
    "running",
    "waiting_for_interaction",
    "recovering",
    "cancelling",
    "failed",
    "cancelled",
  ],
  waiting_for_interaction: [
    "running",
    "waiting_for_question",
    "recovering",
    "cancelling",
    "failed",
    "cancelled",
  ],
  recovering: ["running", "cancelling", "failed", "lost"],
  cancelling: ["completed", "failed", "cancelled", "timed_out", "lost"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  lost: [],
};

function resultState(
  result: AdapterExecutionResult,
  wasCancelled: boolean,
): Extract<HarnessExecutionState, "completed" | "failed" | "cancelled" | "timed_out"> {
  if (wasCancelled || result.status === "cancelled") return "cancelled";
  if (result.status === "timed_out" || result.timedOut) return "timed_out";
  if (result.status === "completed") return "completed";
  if (result.status === undefined && result.exitCode === 0) return "completed";
  return "failed";
}

/**
 * Stable orchestration boundary for all harness adapters.
 *
 * Adapters remain provider-specific transports. This class owns execution
 * identity, lifecycle, cancellation, questions, and event fan-out so callers
 * do not need to reach into an adapter implementation.
 */
export class HarnessController {
  private readonly records = new Map<string, RunRecord>();
  private readonly store: HarnessControllerStore;
  private readonly terminalRetentionMs: number;
  private readonly replayBufferSize: number;

  constructor(options?: {
    store?: HarnessControllerStore;
    terminalRetentionMs?: number;
    replayBufferSize?: number;
  }) {
    this.store = options?.store ?? NOOP_STORE;
    this.terminalRetentionMs = options?.terminalRetentionMs ?? 5 * 60_000;
    this.replayBufferSize = Math.max(1, options?.replayBufferSize ?? 10_000);
  }

  start(request: HarnessControllerRequest): HarnessExecutionHandle {
    if (!request.context.execution || typeof request.context.execution.run !== "function") {
      throw new Error("harness executions require a runtime execution boundary");
    }
    const executionId = request.executionId ?? `exec_${randomUUID()}`;
    if (this.records.has(executionId)) {
      throw new Error(`Harness execution already exists: ${executionId}`);
    }

    const abortController = new AbortController();
    const now = new Date().toISOString();
    const snapshot: HarnessExecutionSnapshot = {
      version: 1,
      revision: 0,
      executionId,
      state: "created",
      createdAt: now,
      updatedAt: now,
      pendingInteractions: {},
    };
    const record: RunRecord = {
      adapter: request.adapter,
      abortController,
      context: request.context,
      listeners: new Set(),
      questionHandler: request.context.onQuestion,
      permissionHandler: request.context.onPermission,
      pendingInteractions: new Map(),
      resolvedInteractions: new Set(),
      snapshot,
      history: [],
      nextSequence: 1,
      transitionTail: Promise.resolve(),
    };
    this.records.set(executionId, record);

    const externalAbort = (): void => abortController.abort();
    if (request.context.signal?.aborted) abortController.abort();
    else request.context.signal?.addEventListener("abort", externalAbort, { once: true });

    const done = this.execute(record, executionId, externalAbort).finally(() => {
      request.context.signal?.removeEventListener("abort", externalAbort);
    });

    const handle: HarnessExecutionHandle = {
      executionId,
      done,
      snapshot: () => cloneSnapshot(record.snapshot),
      subscribe: (listener) => {
        record.listeners.add(listener);
        return () => record.listeners.delete(listener);
      },
      replay: (fromSequence = 1) =>
        record.history
          .filter((entry) => entry.sequence >= fromSequence)
          .map((entry) => ({
            ...entry,
            event: cloneEvent(entry.event),
          })),
      cancel: async (reason) => this.cancel(executionId, reason),
      answerQuestion: (answer) => this.answerQuestion(executionId, answer),
      respondInteraction: (id, response) => this.respondInteraction(executionId, id, response),
    };
    return handle;
  }

  get(executionId: string): HarnessExecutionSnapshot | undefined {
    const record = this.records.get(executionId);
    return record ? cloneSnapshot(record.snapshot) : undefined;
  }

  async cancel(executionId: string, reason = "cancelled_by_user"): Promise<boolean> {
    const record = this.records.get(executionId);
    if (!record || terminal(record.snapshot.state) || record.snapshot.state === "cancelling") {
      return false;
    }
    record.snapshot.cancelReason = reason;
    record.abortController.abort();
    if (terminal(record.snapshot.state)) return false;
    try {
      await this.transition(record, "cancelling");
    } catch (error) {
      if (terminal(record.snapshot.state)) return false;
      throw error;
    }
    const providerSessionId = record.snapshot.providerSessionId ?? record.context.runtime.sessionId;
    if (providerSessionId && record.adapter.cancel) {
      try {
        await record.adapter.cancel({ sessionId: providerSessionId, reason });
      } catch (error) {
        record.snapshot.errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
    return true;
  }

  answerQuestion(executionId: string, answer: string): boolean {
    const record = this.records.get(executionId);
    const pending = record
      ? [...record.pendingInteractions.values()].find((item) => item.snapshot.kind === "question")
      : undefined;
    return Boolean(
      record &&
        pending &&
        this.respondInteraction(executionId, pending.snapshot.id, { kind: "question", answer }),
    );
  }

  respondInteraction(
    executionId: string,
    interactionId: string,
    response: HarnessInteractionResponse,
  ): boolean {
    const record = this.records.get(executionId);
    const pending = record?.pendingInteractions.get(interactionId);
    if (!record) return false;
    // Answer delivery is idempotent: a retried UI request must not send a
    // second response to the native provider. Returning true for an already
    // resolved id lets callers safely retry after a transport timeout.
    if (!pending) return record.resolvedInteractions.has(interactionId);
    if (terminal(record.snapshot.state)) return false;
    record.pendingInteractions.delete(interactionId);
    record.resolvedInteractions.add(interactionId);
    if (record.snapshot.pendingInteractions)
      delete record.snapshot.pendingInteractions[interactionId];
    const nextQuestion = [...record.pendingInteractions.values()].find(
      (item) => item.snapshot.kind === "question",
    );
    record.snapshot.question =
      nextQuestion?.snapshot.kind === "question" ? nextQuestion.snapshot.question : undefined;
    pending.resolve(response);
    if (!record.abortController.signal.aborted) {
      const nextState: HarnessExecutionState =
        record.pendingInteractions.size === 0
          ? "running"
          : nextQuestion
            ? "waiting_for_question"
            : "waiting_for_interaction";
      void this.transition(record, nextState).catch((error) => {
        record.snapshot.errorMessage = error instanceof Error ? error.message : String(error);
        record.abortController.abort();
      });
    }
    return true;
  }

  private async execute(
    record: RunRecord,
    executionId: string,
    externalAbort: () => void,
  ): Promise<AdapterExecutionResult> {
    if (record.abortController.signal.aborted) {
      const cancelled = cancelledResult();
      record.snapshot.result = cancelled;
      record.snapshot.finishedAt = new Date().toISOString();
      await this.transition(record, "cancelling");
      await this.transition(record, "cancelled");
      await this.emit(record, { type: "result", result: cancelled });
      return cancelled;
    }
    await this.transition(record, "starting");
    const original = record.context;
    const context: AdapterExecutionContext = {
      ...original,
      runId: executionId,
      signal: record.abortController.signal,
      onEvent: async (event) => {
        if (event.nativeSessionId) record.snapshot.providerSessionId = event.nativeSessionId;
        await original.onEvent?.(event);
        await this.emit(record, { type: "provider.event", event });
        if (record.journalFailure) throw record.journalFailure;
      },
      onRawLog: async (entry) => {
        await original.onRawLog?.(entry);
        await this.emit(record, { type: "raw.log", entry });
        if (record.journalFailure) throw record.journalFailure;
      },
      onQuestion: async (question) => this.waitForQuestion(record, question),
      onPermission: async (permission) => this.waitForPermission(record, permission),
    };

    record.context = context;
    try {
      if (record.journalFailure) throw record.journalFailure;
      if (record.abortController.signal.aborted || record.snapshot.state === "cancelling") {
        const cancelled = cancelledResult();
        record.snapshot.result = cancelled;
        record.snapshot.finishedAt = new Date().toISOString();
        if (record.snapshot.state !== "cancelling") await this.transition(record, "cancelling");
        await this.transition(record, "cancelled");
        await this.emit(record, { type: "result", result: cancelled });
        return cancelled;
      }
      await this.transition(record, "running");
      if (record.journalFailure) throw record.journalFailure;
      if (record.abortController.signal.aborted) {
        const cancelled: AdapterExecutionResult = {
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          exitCode: null,
          timedOut: false,
          status: "cancelled",
          usageBasis: "per_run",
          clearSession: false,
        };
        record.snapshot.result = cancelled;
        record.snapshot.finishedAt = new Date().toISOString();
        await this.transition(record, "cancelled");
        await this.emit(record, { type: "result", result: cancelled });
        return cancelled;
      }
      const result = await record.adapter.execute(context);
      if (result.sessionId) record.snapshot.providerSessionId = result.sessionId;
      record.snapshot.result = result;
      record.snapshot.question = undefined;
      record.snapshot.finishedAt = new Date().toISOString();
      await this.transition(record, resultState(result, record.abortController.signal.aborted));
      await this.emit(record, { type: "result", result });
      if (record.journalFailure) throw record.journalFailure;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.snapshot.errorMessage = message;
      record.snapshot.finishedAt = new Date().toISOString();
      if (record.journalFailure) {
        // The durable boundary is authoritative. If it fails, resolve the
        // run as failed (rather than rejecting `done`) and never report a
        // successful terminal state, even if the provider already returned.
        const failed = failedResult(`durable journal failed: ${record.journalFailure.message}`);
        record.snapshot.result = failed;
        record.snapshot.state = "failed";
        record.snapshot.revision = (record.snapshot.revision ?? 0) + 1;
        record.snapshot.updatedAt = new Date().toISOString();
        record.snapshot.finishedAt = new Date().toISOString();
        return failed;
      }
      if (record.abortController.signal.aborted && record.snapshot.state !== "failed") {
        const cancelled = cancelledResult();
        record.snapshot.result = cancelled;
        if (!terminal(record.snapshot.state)) {
          if (record.snapshot.state !== "cancelling") await this.transition(record, "cancelling");
          await this.transition(record, "cancelled");
        }
        await this.emit(record, { type: "result", result: cancelled });
        return cancelled;
      }
      const failed = failedResult(message);
      record.snapshot.result = failed;
      if (!terminal(record.snapshot.state)) await this.transition(record, "failed");
      await this.emit(record, { type: "error", message });
      return failed;
    } finally {
      original.signal?.removeEventListener("abort", externalAbort);
      for (const pending of record.pendingInteractions.values()) {
        pending.resolve(undefined);
      }
      record.pendingInteractions.clear();
      record.snapshot.pendingInteractions = {};
      if (terminal(record.snapshot.state)) this.scheduleDisposal(record);
    }
  }

  private async waitForQuestion(
    record: RunRecord,
    question: HarnessQuestion,
  ): Promise<string | undefined> {
    if (record.abortController.signal.aborted) return undefined;
    const id = `question_${randomUUID()}`;
    const interaction: HarnessInteractionSnapshot = {
      id,
      kind: "question",
      question,
      createdAt: new Date().toISOString(),
    };
    record.snapshot.question = question;
    let resolveAnswer!: (answer: string | undefined) => void;
    const answer = new Promise<string | undefined>((resolve) => {
      resolveAnswer = resolve;
      record.pendingInteractions.set(id, {
        snapshot: interaction,
        resolve: (response) => resolve(response?.kind === "question" ? response.answer : undefined),
      });
      record.snapshot.pendingInteractions ??= {};
      record.snapshot.pendingInteractions[id] = interaction;
      if (record.abortController.signal.aborted) {
        record.pendingInteractions.delete(id);
        delete record.snapshot.pendingInteractions[id];
        resolve(undefined);
      }
    });
    // Preserve the question-specific state for UI callers while the snapshot
    // carries a typed interaction ID for concurrent responses.
    await this.transition(record, "waiting_for_question");
    await this.emit(record, { type: "question", question });
    if (record.journalFailure) {
      record.pendingInteractions.delete(id);
      delete record.snapshot.pendingInteractions?.[id];
      record.resolvedInteractions.add(id);
      resolveAnswer(undefined);
      return undefined;
    }
    // Run the supplied callback as a fallback responder without bypassing the
    // run-bound interaction map; an explicit controller answer wins the race.
    if (record.questionHandler) {
      void Promise.resolve()
        .then(() => record.questionHandler?.(question))
        .then((answer) => {
          if (record.pendingInteractions.has(id)) {
            this.respondInteraction(record.snapshot.executionId, id, {
              kind: "question",
              answer: answer ?? "",
            });
          }
        })
        .catch(() => {
          if (record.pendingInteractions.has(id)) {
            this.respondInteraction(record.snapshot.executionId, id, {
              kind: "question",
              answer: "",
            });
          }
        });
    }
    return answer;
  }

  private async waitForPermission(
    record: RunRecord,
    permission: { toolName: string; description?: string; input?: unknown },
  ): Promise<"once" | "always" | "reject"> {
    if (record.abortController.signal.aborted) return "reject";
    const id = `permission_${randomUUID()}`;
    const interaction: HarnessInteractionSnapshot = {
      id,
      kind: "permission",
      permission,
      createdAt: new Date().toISOString(),
    };
    let resolveAnswer!: (answer: "once" | "always" | "reject") => void;
    const answer = new Promise<"once" | "always" | "reject">((resolve) => {
      resolveAnswer = resolve;
      record.pendingInteractions.set(id, {
        snapshot: interaction,
        resolve: (response) =>
          resolve(response?.kind === "permission" ? response.response : "reject"),
      });
      record.snapshot.pendingInteractions ??= {};
      record.snapshot.pendingInteractions[id] = interaction;
    });
    await this.transition(record, "waiting_for_interaction");
    await this.emit(record, { type: "permission", permission });
    if (record.journalFailure) {
      record.pendingInteractions.delete(id);
      delete record.snapshot.pendingInteractions?.[id];
      record.resolvedInteractions.add(id);
      resolveAnswer("reject");
      return "reject";
    }
    if (record.permissionHandler) {
      void Promise.resolve()
        .then(() => record.permissionHandler?.(permission))
        .then((response) => {
          if (record.pendingInteractions.has(id)) {
            this.respondInteraction(record.snapshot.executionId, id, {
              kind: "permission",
              response: response ?? "reject",
            });
          }
        })
        .catch(() => {
          if (record.pendingInteractions.has(id)) {
            this.respondInteraction(record.snapshot.executionId, id, {
              kind: "permission",
              response: "reject",
            });
          }
        });
    }
    return answer;
  }

  private async transition(record: RunRecord, state: HarnessExecutionState): Promise<void> {
    const operation = async (): Promise<void> => {
      const current = record.snapshot.state;
      if (current === state) return;
      if (!ALLOWED_TRANSITIONS[current].includes(state)) {
        throw new Error(`invalid harness transition: ${current} -> ${state}`);
      }
      record.snapshot.state = state;
      if (!record.snapshot.startedAt && state !== "created") {
        record.snapshot.startedAt = new Date().toISOString();
      }
      record.snapshot.revision = (record.snapshot.revision ?? 0) + 1;
      record.snapshot.updatedAt = new Date().toISOString();
      await this.emit(record, { type: "state.changed", snapshot: cloneSnapshot(record.snapshot) });
    };
    // Cancellation, interaction responses, and provider completion can all
    // arrive on different promise turns. Serialize transitions per run so a
    // legal sequence cannot race itself into an invalid state.
    const previous = record.transitionTail;
    const scheduled = previous.catch(() => undefined).then(operation);
    record.transitionTail = scheduled.catch(() => undefined);
    await scheduled;
  }

  private scheduleDisposal(record: RunRecord): void {
    if (record.disposalTimer || this.terminalRetentionMs < 0) return;
    record.disposalTimer = setTimeout(() => {
      record.disposalTimer = undefined;
      this.records.delete(record.snapshot.executionId);
    }, this.terminalRetentionMs);
    record.disposalTimer.unref();
  }

  private async emit(record: RunRecord, event: HarnessControlEvent): Promise<void> {
    const entry: HarnessControlEventRecord = {
      sequence: record.nextSequence++,
      timestamp: new Date().toISOString(),
      event: cloneEvent(event),
    };
    record.history.push(entry);
    if (record.history.length > this.replayBufferSize) record.history.shift();
    try {
      if (event.type === "state.changed" && this.store.compareAndAppend) {
        const committed = await this.store.compareAndAppend(
          record.snapshot.executionId,
          Math.max(0, (record.snapshot.revision ?? 0) - 1),
          event,
          cloneSnapshot(record.snapshot),
        );
        if (committed === false) throw new Error("harness snapshot revision conflict");
      } else if (event.type === "state.changed" && this.store.appendAndSave) {
        await this.store.appendAndSave(
          record.snapshot.executionId,
          event,
          cloneSnapshot(record.snapshot),
        );
      } else {
        await this.store.append(record.snapshot.executionId, event);
        if (event.type === "state.changed") await this.store.save(cloneSnapshot(event.snapshot));
      }
    } catch (error) {
      record.journalFailure = error instanceof Error ? error : new Error(String(error));
      record.abortController.abort();
      record.snapshot.errorMessage = `durable journal failed: ${record.journalFailure.message}`;
      if (!terminal(record.snapshot.state)) {
        record.snapshot.state = "failed";
        record.snapshot.revision = (record.snapshot.revision ?? 0) + 1;
        record.snapshot.updatedAt = new Date().toISOString();
      }
      for (const pending of record.pendingInteractions.values()) pending.resolve(undefined);
      record.pendingInteractions.clear();
      record.snapshot.pendingInteractions = {};
    }
    for (const listener of record.listeners) {
      try {
        void Promise.resolve(listener(cloneEvent(event))).catch(() => undefined);
      } catch {
        // Subscriber failures are isolated from controller state.
      }
    }
  }
}

function cloneSnapshot(snapshot: HarnessExecutionSnapshot): HarnessExecutionSnapshot {
  return {
    ...snapshot,
    pendingInteractions: snapshot.pendingInteractions
      ? { ...snapshot.pendingInteractions }
      : undefined,
    result: snapshot.result ? { ...snapshot.result } : undefined,
  };
}

function cloneEvent(event: HarnessControlEvent): HarnessControlEvent {
  // Events are JSON-shaped by contract. structuredClone preserves binary/tool
  // payloads when an adapter includes them, while the fallback keeps this
  // helper usable in older Node test environments.
  try {
    return structuredClone(event);
  } catch {
    return JSON.parse(JSON.stringify(event)) as HarnessControlEvent;
  }
}

function cancelledResult(): AdapterExecutionResult {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: null,
    timedOut: false,
    status: "cancelled",
    usageBasis: "per_run",
    clearSession: false,
  };
}

function failedResult(message: string): AdapterExecutionResult {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: null,
    timedOut: false,
    status: "failed",
    errorMessage: message.slice(0, 8_192),
    usageBasis: "per_run",
    clearSession: false,
  };
}
