"use client";

import type { ChatRequestOptions, ChatTransport, UIMessage, UIMessageChunk } from "ai";

/**
 * A custom AI SDK `ChatTransport` that bridges our aaspai chat backend
 * to the standard `useChat` protocol.
 *
 * Flow:
 *   1. POST `/api/chat/agent/<id>` with `{ message, adapter, model, runtime }`
 *      → returns `{ sessionId, status }` immediately (execution is backgrounded).
 *   2. Open the SSE stream at `/api/sessions/<sessionId>/stream`.
 *   3. Convert each `session_events` frame into AI SDK `UIMessageChunk`
 *      objects (`text-start/delta/end`, `reasoning-*`, `tool-*`) so
 *      `useChat` maintains standard `UIMessage` state.
 *
 * This keeps the backend unchanged while the frontend speaks the
 * industry-standard AI SDK message format.
 */

interface StreamEventFrame {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  ts: string;
}

interface StreamStatusFrame {
  status: string;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted", "lost"]);

export interface AaspaiChatTransportOptions {
  agentId: string;
  adapter: string;
  model: string | null;
  runtime: Record<string, unknown>;
  /** Previous turn's session row id — chains this turn into the thread. */
  parentSessionId?: string | null;
  /** Previous turn's runtime session id — adapter `--session` resume. */
  resumeSessionId?: string | null;
  resumeSessionParams?: Record<string, unknown> | null;
  /**
   * Live resume source — called at send time (not construction time) so
   * the thread can keep the transport's chain info current across turns.
   * Returns the parent + adapter resume payload, or undefined.
   */
  getResume?: () =>
    | {
        parentSessionId?: string | null;
        resumeSessionId?: string | null;
        resumeSessionParams?: Record<string, unknown> | null;
      }
    | undefined;
  /** Fired when the backend creates a new session for this turn. */
  onSessionCreated?: (sessionId: string) => void;
  /** Fired when the turn's SSE stream reaches a terminal status. */
  onTurnFinished?: (sessionId: string) => void;
}

export class AaspaiChatTransport implements ChatTransport<UIMessage> {
  constructor(private readonly options: AaspaiChatTransportOptions) {}

  async sendMessages({
    messages,
    abortSignal,
    ...requestOptions
  }: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messageId: string | undefined;
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
  } & ChatRequestOptions): Promise<ReadableStream<UIMessageChunk>> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser
      ? lastUser.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
          .join("")
      : "";
    const body = requestOptions.body ?? {};
    const resume = this.options.getResume?.();
    const parentSessionId = this.options.parentSessionId ?? resume?.parentSessionId ?? undefined;
    const resumeSessionId = this.options.resumeSessionId ?? resume?.resumeSessionId ?? undefined;
    const resumeSessionParams =
      this.options.resumeSessionParams ?? resume?.resumeSessionParams ?? undefined;
    const options = this.options;
    const res = await fetch(`/api/chat/${encodeURIComponent(this.options.agentId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: text,
        adapter: this.options.adapter,
        model: this.options.model,
        runtime: this.options.runtime,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(resumeSessionParams ? { resumeSessionParams } : {}),
        ...body,
      }),
      signal: abortSignal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { sessionId?: string; status?: string };
    if (!data.sessionId) throw new Error("no session id returned");

    const sessionId = data.sessionId;
    this.options.onSessionCreated?.(sessionId);
    const messageId = `msg-${sessionId}`;

    // Track open tool calls so tool_result merges into the tool part.
    const toolByCallId = new Map<string, { name: string }>();
    let finished = false;

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        const send = (chunk: UIMessageChunk) => {
          if (finished) return;
          try {
            controller.enqueue(chunk);
          } catch {
            /* closed */
          }
        };
        const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`);
        es.addEventListener("event", (event) => {
          try {
            const frame = JSON.parse((event as MessageEvent).data) as StreamEventFrame;
            const p = frame.payload ?? {};
            switch (frame.kind) {
              case "assistant": {
                const delta = typeof p.text === "string" ? p.text : "";
                if (delta) {
                  send({ type: "text-delta", delta, id: messageId });
                }
                break;
              }
              case "thinking": {
                const delta = typeof p.text === "string" ? p.text : "";
                if (delta) {
                  send({ type: "reasoning-delta", delta, id: messageId });
                }
                break;
              }
              case "tool_call": {
                const toolName = typeof p.name === "string" ? p.name : "tool";
                const toolCallId = typeof p.id === "string" && p.id ? p.id : `call-${frame.seq}`;
                toolByCallId.set(toolCallId, { name: toolName });
                send({
                  type: "tool-input-available",
                  toolName,
                  toolCallId,
                  input: p.input ?? p.arguments ?? {},
                  dynamic: true,
                  title: toolName,
                });
                break;
              }
              case "tool_result": {
                const toolName = typeof p.name === "string" ? p.name : "tool";
                const toolCallId = typeof p.id === "string" && p.id ? p.id : `call-${frame.seq}`;
                toolByCallId.set(toolCallId, { name: toolName });
                const isError = p.isError === true || p.status === "failed";
                if (isError) {
                  send({
                    type: "tool-output-error",
                    toolCallId,
                    errorText: typeof p.output === "string" && p.output ? p.output : "tool failed",
                    dynamic: true,
                  });
                } else {
                  send({
                    type: "tool-output-available",
                    toolCallId,
                    output: p.output ?? "",
                    dynamic: true,
                  });
                }
                break;
              }
              case "result": {
                const summary = typeof p.summary === "string" ? p.summary : "";
                if (summary) send({ type: "text-delta", delta: summary, id: messageId });
                break;
              }
              default:
                break;
            }
          } catch {
            /* ignore malformed frame */
          }
        });
        es.addEventListener("status", (event) => {
          try {
            const frame = JSON.parse((event as MessageEvent).data) as StreamStatusFrame;
            if (frame.status && TERMINAL.has(frame.status)) {
              finished = true;
              send({ type: "text-end", id: messageId });
              es.close();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              options.onTurnFinished?.(sessionId);
            }
          } catch {
            /* ignore */
          }
        });
        es.onerror = () => {
          // Let EventSource auto-reconnect; the status handler closes us.
        };
        abortSignal?.addEventListener(
          "abort",
          () => {
            es.close();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          },
          { once: true },
        );
      },
    });
    return stream;
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}
