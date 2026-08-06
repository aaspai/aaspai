import { newEventId, nowIso } from "./canonical.js";
import { redactBody } from "./redact.js";
import type { LogInsert } from "./repository.js";

/**
 * Aaspai-native normalizer.
 *
 * Bridges harness `TranscriptEntry`s (and raw stdout/stderr lines) into
 * canonical telemetry logs. This is the single producer-side emission
 * point called by `@aaspai/sessions` / `@aaspai/execution`; it never
 * drops the raw line and keeps observed vs received timestamps distinct.
 */

export type NativeStream = "stdout" | "stderr";

export interface NativeEmitContext {
  organizationId: string;
  sessionId?: string;
  executionId?: string;
  attemptId?: string;
  traceId?: string;
  model?: string;
  provider: "aaspai" | "runtime";
  sourceKind: "aaspai_native";
}

export interface NativeLineInput {
  stream: NativeStream;
  line: string;
  ts?: string;
  kind?: string;
  payload?: Record<string, unknown>;
}

export function nativeLineToLog(input: NativeLineInput, ctx: NativeEmitContext): LogInsert {
  const receivedAt = nowIso();
  const observedAt = input.ts ?? receivedAt;
  const { body, redacted } = redactBody(input.line);
  const severityText = input.stream === "stderr" ? "ERROR" : "INFO";
  const severityNumber = input.stream === "stderr" ? 17 : 9;
  return {
    id: newEventId("tlog"),
    organizationId: ctx.organizationId,
    observedAt,
    receivedAt,
    provider: ctx.provider,
    sourceKind: "aaspai_native",
    serviceName: ctx.provider === "aaspai" ? "aaspai" : "runtime",
    eventName: input.kind ?? (input.stream === "stderr" ? "stderr" : "stdout"),
    body,
    severityText,
    severityNumber,
    sessionId: ctx.sessionId,
    executionId: ctx.executionId,
    attemptId: ctx.attemptId,
    traceId: ctx.traceId,
    model: ctx.model,
    attributes: {
      stream: input.stream,
      ...(redacted ? { aaspai_redacted: true } : {}),
      ...(input.payload ? { ...input.payload } : {}),
    },
    rawAvailable: true,
    raw: input.payload ? { line: input.line, ...input.payload } : { line: input.line },
    parseStatus: "ok",
  };
}
