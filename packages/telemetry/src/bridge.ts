import { getDefaultDb } from "@aaspai/db";
import { getLogger } from "@aaspai/observability";
import { nowIso } from "./canonical.js";
import { type NativeEmitContext, nativeLineToLog } from "./native.js";
import {
  type LogInsert,
  type SessionSummaryUpsert,
  TelemetryRepository,
  type TranscriptMessageInsert,
} from "./repository.js";

/**
 * Producer-side observer bridge.
 *
 * Called by `@aaspai/sessions` / `@aaspai/execution` after their own
 * durable writes. Every emission is best-effort: an observer failure
 * must never turn a successful execution into a failed one (plan §6.7),
 * but failures are visible through ingestion errors when possible.
 *
 * The bridge is disabled when `AASPAI_OBSERVER=off`.
 */

const log = getLogger("telemetry.bridge");

// The bridge is a production feature. It is disabled under test runners by
// default (a test can call `setObserverEnabled(true)` explicitly), so the
// observer never opens a second connection to a test database and leaves a
// file lock on Windows.
const TEST_RUNNER =
  process.env.NODE_ENV === "test" || process.env.VITEST !== undefined || !!process.env.VITEST;
let enabled = process.env.AASPAI_OBSERVER !== "off" && !TEST_RUNNER;
let repository: TelemetryRepository | null = null;

export function setObserverEnabled(value: boolean): void {
  enabled = value;
}

export function observerEnabled(): boolean {
  return enabled;
}

function repo(): TelemetryRepository | null {
  if (!enabled) return null;
  if (!repository) {
    try {
      repository = new TelemetryRepository(getDefaultDb());
    } catch (err) {
      log.warn("observer bridge disabled", { err: String(err) });
      return null;
    }
  }
  return repository;
}

export interface BridgeLineInput {
  organizationId: string;
  sessionId?: string;
  executionId?: string;
  attemptId?: string;
  traceId?: string;
  model?: string;
  provider: "aaspai" | "runtime";
  stream: "stdout" | "stderr";
  line: string;
  ts?: string;
  kind?: string;
  payload?: Record<string, unknown>;
  seq: number;
}

/** Emit a single observed line as a normalized telemetry log. */
export function emitNativeLine(input: BridgeLineInput): void {
  const r = repo();
  if (!r) return;
  try {
    const ctx: NativeEmitContext = {
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      executionId: input.executionId,
      attemptId: input.attemptId,
      traceId: input.traceId,
      model: input.model,
      provider: input.provider,
      sourceKind: "aaspai_native",
    };
    const logRow = nativeLineToLog(
      {
        stream: input.stream,
        line: input.line,
        ts: input.ts,
        kind: input.kind,
        payload: input.payload,
      },
      ctx,
    );
    r.insertLogs([
      {
        ...logRow,
        dedupKey: `aaspai:${input.organizationId}:${input.sessionId ?? "x"}:${input.seq}`,
      },
    ]);
    r.appendLiveEvent(input.organizationId, "log", {
      kind: input.kind ?? input.stream,
      sessionId: input.sessionId,
      body: logRow.body,
    });
  } catch (err) {
    log.warn("observer emission failed", { err: String(err) });
  }
}

export interface BridgeSessionResultInput {
  organizationId: string;
  sessionId: string;
  provider: "aaspai";
  model?: string;
  status?: string;
  messageCount: number;
  toolCallCount: number;
  logs: LogInsert[];
  executionId?: string;
  attemptId?: string;
  costUsd?: number | null;
}

/** Project and persist a session summary + transcript (best-effort). */
export function emitSessionProjection(input: BridgeSessionResultInput): void {
  const r = repo();
  if (!r) return;
  try {
    const times = input.logs.map((l) => l.observedAt).filter(Boolean);
    const firstSeenAt = times.length ? times.reduce((a, b) => (a < b ? a : b)) : nowIso();
    const lastSeenAt = times.length ? times.reduce((a, b) => (a > b ? a : b)) : nowIso();
    const summary: SessionSummaryUpsert = {
      id: `tsess_${input.sessionId}`,
      organizationId: input.organizationId,
      provider: input.provider,
      sessionId: input.sessionId,
      firstSeenAt,
      lastSeenAt,
      status: input.status,
      model: input.model,
      executionIds: input.executionId ? [input.executionId] : undefined,
      attemptIds: input.attemptId ? [input.attemptId] : undefined,
      messageCount: input.messageCount,
      toolCallCount: input.toolCallCount,
      costUsd: input.costUsd ?? null,
    };
    r.upsertSessionSummary(summary);
  } catch (err) {
    log.warn("session projection failed", { err: String(err) });
  }
}

/** Append transcript messages for a session (best-effort). */
export function emitTranscriptMessages(rows: TranscriptMessageInsert[]): void {
  const r = repo();
  if (!r) return;
  try {
    r.insertTranscriptMessages(rows);
  } catch (err) {
    log.warn("transcript emission failed", { err: String(err) });
  }
}
