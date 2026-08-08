import type { HarnessEvent, UsageSummary } from "@aaspai/contracts/harness";
import { extractErrorMessage } from "./error-parser.js";
import type { OpenCodeNativeEvent } from "./native-event.js";

/**
 * Diagnostic transcript projection retained for renderers that need a compact
 * line-oriented view alongside the typed semantic event stream.
 */
export type HarnessTranscriptKind =
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "result"
  | "init";

export interface HarnessTranscriptEntry {
  kind: HarnessTranscriptKind;
  ts: string;
  sessionID?: string;
  text?: string;
  delta?: boolean;
  name?: string;
  id?: string;
  status?: string;
  output?: string;
  input?: unknown;
  isError?: boolean;
  event?: string;
  errorMessage?: string;
  summary?: string;
  tokens?: unknown;
  cost?: number;
}

/** Progress payload forwarded to `onRuntimeProgress`. */
export type HarnessProgress =
  | { kind: "text_delta"; ts: string; sessionId?: string; text: string }
  | { kind: "thinking_delta"; ts: string; sessionId?: string; text: string }
  | {
      kind: "tool_event";
      ts: string;
      sessionId?: string;
      name: string;
      id?: string;
      status: string;
      output?: string;
    };

export interface OpenCodeRunState {
  sessionId?: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: number;
  thinkingEventCount: number;
  toolEventCount: number;
  toolsInvoked: string[];
  toolEvents: Array<{ name: string; status: string; output?: string; id?: string }>;
  jsonErrorMessage?: string;
}

export interface ApplyResult {
  transcript: HarnessTranscriptEntry[];
  progress: HarnessProgress[];
  events: HarnessEvent[];
}

export interface OpenCodeAccumulator {
  apply(event: OpenCodeNativeEvent, ts?: string): ApplyResult;
  result(): OpenCodeRunState;
}

const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;

function boundedText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_TOOL_OUTPUT_BYTES) return value;
  const marker = "\n… [tool output truncated]";
  const budget = Math.max(0, MAX_TOOL_OUTPUT_BYTES - new TextEncoder().encode(marker).byteLength);
  return `${new TextDecoder().decode(bytes.subarray(0, budget))}${marker}`;
}

const isReasoning = (event: OpenCodeNativeEvent): boolean =>
  (event.type === "thinking" && event.part?.type === "thinking") ||
  event.part?.type === "reasoning";

function stateStatus(status: string | undefined): string {
  if (status === "error") return "failed";
  return status ?? "started";
}

export function createOpenCodeAccumulator(): OpenCodeAccumulator {
  const state: OpenCodeRunState = {
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cost: 0,
    thinkingEventCount: 0,
    toolEventCount: 0,
    toolsInvoked: [],
    toolEvents: [],
  };
  const dispatched = new Set<string>();
  const toolLastState = new Map<string, string>();
  const toolTerminal = new Set<string>();
  const textParts = new Map<string, string>();
  const reasoningParts = new Map<string, string>();
  const completedSteps = new Set<string>();
  const observedErrors = new Set<string>();

  let announcedNativeSession = false;
  const apply = (event: OpenCodeNativeEvent, ts = new Date().toISOString()): ApplyResult => {
    const transcript: HarnessTranscriptEntry[] = [];
    const progress: HarnessProgress[] = [];
    const events: HarnessEvent[] = [];

    if (event.sessionID) {
      const isFirstSession = state.sessionId === undefined;
      state.sessionId = event.sessionID;
      if (isFirstSession && !announcedNativeSession) {
        announcedNativeSession = true;
        events.push({ type: "native.session", timestamp: ts, nativeSessionId: event.sessionID });
      }
    }

    // ── text ────────────────────────────────────────────────────────
    if (
      event.type === "text" &&
      event.part?.type === "text" &&
      typeof event.part.text === "string"
    ) {
      const partKey = event.part.id ?? event.part.messageID;
      const previous = partKey ? textParts.get(partKey) : undefined;
      const chunk =
        previous === event.part.text
          ? ""
          : previous && event.part.text.startsWith(previous)
            ? event.part.text.slice(previous.length)
            : event.part.text;
      if (partKey) textParts.set(partKey, event.part.text);
      if (chunk.length === 0) return { transcript, progress, events };
      state.text += chunk;
      transcript.push({
        kind: "assistant",
        ts,
        sessionID: state.sessionId,
        text: chunk,
        delta: true,
      });
      progress.push({ kind: "text_delta", ts, sessionId: state.sessionId, text: chunk });
      events.push({
        type: "assistant.delta",
        timestamp: ts,
        text: chunk,
        nativeSessionId: state.sessionId,
      });
    }

    // ── thinking / reasoning ────────────────────────────────────────
    if (isReasoning(event) && typeof event.part?.text === "string") {
      state.thinkingEventCount += 1;
      const partKey = event.part.id ?? event.part.messageID;
      const previous = partKey ? reasoningParts.get(partKey) : undefined;
      const text =
        previous === event.part.text
          ? ""
          : previous && event.part.text.startsWith(previous)
            ? event.part.text.slice(previous.length)
            : event.part.text;
      if (partKey) reasoningParts.set(partKey, event.part.text);
      if (text.length === 0) return { transcript, progress, events };
      transcript.push({ kind: "thinking", ts, sessionID: state.sessionId, text, delta: true });
      progress.push({ kind: "thinking_delta", ts, sessionId: state.sessionId, text });
      events.push({
        type: "reasoning.delta",
        timestamp: ts,
        text,
        nativeSessionId: state.sessionId,
      });
    }

    // ── tools ───────────────────────────────────────────────────────
    if (event.type === "tool_use" || event.type === "tool" || event.part?.type === "tool") {
      state.toolEventCount += 1;
      const toolName = (event.part?.tool as string | undefined) ?? "unknown";
      const callId =
        (event.part?.callID as string | undefined) ?? (event.part?.id as string | undefined);
      const status = stateStatus((event.part?.state as { status?: string } | undefined)?.status);
      const toolInput =
        (event.part as { input?: unknown } | undefined)?.input ??
        (event.part as { args?: unknown } | undefined)?.args ??
        (event.part?.state as { input?: unknown } | undefined)?.input ??
        {};
      const toolState = event.part?.state as { output?: unknown; error?: unknown } | undefined;
      const output =
        typeof toolState?.output === "string" ? boundedText(toolState.output) : undefined;
      const toolKey = `${callId ?? "no-id"}:${toolName}`;
      const isFirst = !dispatched.has(toolKey);
      const snapshotKey = `${status}:${typeof output === "string" ? output : ""}:${JSON.stringify(toolInput)}`;
      if (!isFirst && toolLastState.get(toolKey) === snapshotKey) {
        return { transcript, progress, events };
      }
      toolLastState.set(toolKey, snapshotKey);
      if (isFirst) {
        dispatched.add(toolKey);
        state.toolsInvoked.push(toolName);
      }
      // Provider tool errors surface as `state.error` — surface it on the
      // failed-tool event so orchestrators can render the failure reason.
      const failedToolError =
        status === "failed" && typeof toolState?.error === "string" ? toolState.error : undefined;

      transcript.push({
        kind:
          status === "completed" || status === "failed" || status === "cancelled"
            ? "tool_result"
            : "tool_call",
        ts,
        sessionID: state.sessionId,
        name: toolName,
        id: callId,
        status: status as "started" | "completed" | "failed" | "cancelled",
        output: boundedText(failedToolError) ?? output,
        isError: status === "failed",
      });
      progress.push({
        kind: "tool_event",
        ts,
        sessionId: state.sessionId,
        name: toolName,
        id: callId,
        status,
      });
      if (isFirst) {
        if (status === "completed" || status === "failed") {
          toolTerminal.add(toolKey);
          state.toolEvents.push({ name: toolName, status, output, id: callId });
          events.push({
            type: status === "failed" ? "tool.failed" : "tool.completed",
            timestamp: ts,
            toolName,
            toolCallId: callId,
            input: toolInput,
            output: boundedText(failedToolError) ?? output,
            ...(status === "failed" && failedToolError
              ? { errorMessage: boundedText(failedToolError) }
              : {}),
            executionAuthority: "native",
            nativeSessionId: state.sessionId,
          });
        } else {
          events.push({
            type: "tool.started",
            timestamp: ts,
            toolName,
            toolCallId: callId,
            input: toolInput,
            executionAuthority: "native",
            nativeSessionId: state.sessionId,
          });
        }
      } else if (
        (status === "completed" || status === "failed" || status === "cancelled") &&
        !toolTerminal.has(toolKey)
      ) {
        toolTerminal.add(toolKey);
        state.toolEvents.push({ name: toolName, status, output, id: callId });
        events.push({
          type: status === "failed" ? "tool.failed" : "tool.completed",
          timestamp: ts,
          toolName,
          toolCallId: callId,
          input: toolInput,
          output: boundedText(failedToolError) ?? output,
          ...(status === "failed" && failedToolError
            ? { errorMessage: boundedText(failedToolError) }
            : {}),
          executionAuthority: "native",
          nativeSessionId: state.sessionId,
        });
      }

      // Company actions ride the native tool surface — captured
      // provider-neutrally (the tools package interprets them later).
    }

    // ── step_finish (usage) ─────────────────────────────────────────
    if (event.type === "step_finish" && event.part?.tokens) {
      const stepKey = event.part.id ?? event.part.messageID;
      if (stepKey && completedSteps.has(stepKey)) return { transcript, progress, events };
      if (stepKey) completedSteps.add(stepKey);
      const tokens = event.part.tokens;
      if (typeof tokens.input === "number")
        state.inputTokens = Math.max(state.inputTokens, tokens.input);
      if (typeof tokens.output === "number")
        state.outputTokens = Math.max(state.outputTokens, tokens.output);
      if (typeof tokens.cache?.read === "number") {
        state.cachedInputTokens = Math.max(state.cachedInputTokens, tokens.cache.read);
      }
      if (typeof tokens.total === "number") {
        const inferred = tokens.total - state.inputTokens - state.outputTokens;
        if (inferred > 0) state.inputTokens = Math.max(state.inputTokens, inferred);
      }
      if (typeof event.part.cost === "number") state.cost = Math.max(state.cost, event.part.cost);
      const usage: UsageSummary = {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        ...(state.cachedInputTokens > 0 ? { cachedInputTokens: state.cachedInputTokens } : {}),
      };
      transcript.push({
        kind: "result",
        ts,
        sessionID: state.sessionId,
        summary: state.text.slice(0, 200),
        tokens: event.part.tokens,
        cost: state.cost,
      });
      events.push({
        type: "step.completed",
        timestamp: ts,
        usage,
        nativeSessionId: state.sessionId,
      });
      events.push({ type: "usage", timestamp: ts, usage, nativeSessionId: state.sessionId });
    }

    // ── errors ──────────────────────────────────────────────────────
    if (event.type === "error") {
      const msg = extractErrorMessage(event.error);
      const errorKey = `${msg ?? ""}:${JSON.stringify(event.error)}`;
      if (observedErrors.has(errorKey)) return { transcript, progress, events };
      observedErrors.add(errorKey);
      if (msg) {
        state.jsonErrorMessage = state.jsonErrorMessage ? `${state.jsonErrorMessage}; ${msg}` : msg;
      }
      transcript.push({
        kind: "init",
        ts,
        sessionID: state.sessionId,
        event: "error",
        errorMessage: msg,
      });
      events.push({
        type: "error",
        timestamp: ts,
        message: msg ?? "opencode error",
        nativeSessionId: state.sessionId,
      });
    }

    // ── anything else (incl. step_start) ────────────────────────────
    if (transcript.length === 0) {
      transcript.push({ kind: "init", ts, sessionID: state.sessionId, event: event.type });
    }

    return { transcript, progress, events };
  };

  return {
    apply,
    result: () => ({ ...state, text: state.text }),
  };
}
