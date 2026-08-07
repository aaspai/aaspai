"use client";

import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { ChatMessage } from "@/components/chat-message";
import { Card } from "@/components/ui/card";
import { AaspaiChatTransport } from "@/lib/aaspai-chat-transport";

export interface RuntimeOption {
  type: string;
  label: string;
  ready: boolean;
  target: Record<string, unknown>;
  checks: Array<{ ready: boolean; message: string }>;
}

export interface ConversationResume {
  parentSessionId: string | null;
  resumeSessionId: string | null;
  resumeSessionParams: Record<string, unknown> | null;
}

interface Props {
  agentId: string;
  agentTitle: string;
  adapter: string;
  model: string | null;
  runtimes: RuntimeOption[];
  defaultRuntime: Record<string, unknown> | null;
  /** Root session id of the conversation to restore, or null for a new chat. */
  conversationId: string | null;
  onBusyChange?: (busy: boolean) => void;
  /** Fired after a new turn's session is created (the thread id). */
  onSessionCreated?: (sessionId: string) => void;
  /** Fired after a turn finishes — lets the sidebar refresh. */
  onConversationUpdated?: () => void;
}

const EMPTY_SUGGESTIONS = [
  "What can you do?",
  "What is everyone working on?",
  "Summarize the last company decision",
  "Draft a plan for next quarter",
];

/**
 * A single conversation thread. Restores the transcript (via the
 * conversation detail endpoint), then `useChat` appends new turns. Each
 * turn POSTs to the chat route with the previous turn's row id
 * (`parentSessionId`) + runtime session id (`resume`), so the adapter
 * continues with memory and the thread is a chain of linked sessions.
 */
export function ConversationThread({
  agentId,
  agentTitle,
  adapter,
  model,
  runtimes,
  defaultRuntime,
  conversationId,
  onBusyChange,
  onSessionCreated,
  onConversationUpdated,
}: Props) {
  const [input, setInput] = useState("");
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(null);
  const [loading, setLoading] = useState(conversationId != null);
  const resumeRef = useRef<ConversationResume>({
    parentSessionId: null,
    resumeSessionId: null,
    resumeSessionParams: null,
  });

  // Runtime picker (same as the old console).
  const showRuntimePicker =
    runtimes.length > 1 || (defaultRuntime && defaultRuntime.kind !== "local");
  const defaultType = (() => {
    if (defaultRuntime?.kind === "sandbox" && defaultRuntime.provider === "daytona")
      return "sandbox:daytona";
    if (defaultRuntime?.kind === "sandbox")
      return runtimes.find((r) => r.type.startsWith("sandbox:"))?.type ?? "local";
    return "local";
  })();
  const [runtimeType, setRuntimeType] = useState(defaultType);
  const selectedRuntime =
    runtimes.find((r) => r.type === runtimeType) ?? runtimes.find((r) => r.ready) ?? runtimes[0];

  // Fresh values for the memoized transport — callbacks and the thread id
  // change without recreating the transport (which would drop `useChat`
  // state), so they're read through refs at call time.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const onSessionCreatedRef = useRef(onSessionCreated);
  onSessionCreatedRef.current = onSessionCreated;
  const onConversationUpdatedRef = useRef(onConversationUpdated);
  onConversationUpdatedRef.current = onConversationUpdated;

  // Load the conversation transcript once per conversation id.
  useEffect(() => {
    if (!conversationId) {
      setInitialMessages([]);
      setLoading(false);
      resumeRef.current = {
        parentSessionId: null,
        resumeSessionId: null,
        resumeSessionParams: null,
      };
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/inbox/conversations/${encodeURIComponent(conversationId)}`, {
      cache: "no-store",
    })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ messages: UIMessage[]; resume: ConversationResume }>)
          : Promise.reject(r),
      )
      .then((data) => {
        if (cancelled) return;
        resumeRef.current = data.resume;
        setInitialMessages(data.messages);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setInitialMessages([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const transport = useMemo(
    () =>
      new AaspaiChatTransport({
        agentId,
        adapter,
        model,
        runtime: selectedRuntime?.target ?? { kind: "local", envPassthrough: false },
        getResume: () => ({
          parentSessionId: resumeRef.current.parentSessionId,
          resumeSessionId: resumeRef.current.resumeSessionId,
          resumeSessionParams: resumeRef.current.resumeSessionParams,
        }),
        onSessionCreated: (sessionId) => {
          // First turn of a new chat: the session is the thread root.
          resumeRef.current = {
            ...resumeRef.current,
            parentSessionId: sessionId,
            resumeSessionId: null,
            resumeSessionParams: null,
          };
          onSessionCreatedRef.current?.(sessionId);
        },
        onTurnFinished: (sessionId) => {
          onConversationUpdatedRef.current?.();
          // The runtime session id is known only after the run; refetch
          // the thread's resume so the next turn chains with adapter
          // memory. Parent stays the last row (this turn's id).
          const root = conversationIdRef.current ?? sessionId;
          if (!root) return;
          fetch(`/api/inbox/conversations/${encodeURIComponent(root)}`, {
            cache: "no-store",
          })
            .then((r) =>
              r.ok ? (r.json() as Promise<{ resume: ConversationResume }>) : Promise.reject(r),
            )
            .then((data) => {
              resumeRef.current = {
                ...data.resume,
                parentSessionId: data.resume.parentSessionId ?? resumeRef.current.parentSessionId,
              };
            })
            .catch(() => undefined);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId, adapter, model, selectedRuntime],
  );

  const { messages, sendMessage, status, stop } = useChat({
    messages: initialMessages ?? undefined,
    transport,
  });

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    onBusyChange?.(busy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, onBusyChange]);

  const handleSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setInput("");
      void sendMessage({ text: trimmed });
    },
    [busy, sendMessage],
  );

  return (
    <Card className="flex flex-1 flex-col overflow-hidden">
      <Conversation className="min-h-0">
        <ConversationContent>
          {loading && <p className="p-4 text-sm text-muted-foreground">Loading conversation…</p>}
          {!loading && messages.length === 0 && (
            <EmptyChat agentTitle={agentTitle} onPick={handleSend} />
          )}
          {messages.map((message) => (
            <ChatMessage key={message.id} message={message} />
          ))}
          {busy && messages[messages.length - 1]?.role === "user" && (
            <ChatMessage key="pending" message={{ id: "pending", role: "assistant", parts: [] }} />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t p-3">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {showRuntimePicker && selectedRuntime && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Runtime</span>
              <select
                value={runtimeType}
                onChange={(e) => setRuntimeType(e.target.value)}
                className="h-7 rounded-md border bg-background px-2 text-xs"
              >
                {runtimes.map((runtime) => (
                  <option key={runtime.type} value={runtime.type} disabled={!runtime.ready}>
                    {runtime.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <PromptInput
            onSubmit={(message) => handleSend(message.text)}
            className="rounded-lg border bg-card"
          >
            <PromptInputBody>
              <PromptInputTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={`Message ${agentTitle}…`}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <span className="px-2 text-xs text-muted-foreground">{model ?? "default model"}</span>
              <PromptInputSubmit status={status} onStop={stop} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </Card>
  );
}

function EmptyChat({ agentTitle, onPick }: { agentTitle: string; onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center py-16 text-center">
      <h2 className="text-lg font-semibold">Talk to {agentTitle}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Start a conversation. Replies stream in live and every turn is saved to the thread.
      </p>
      <div className="mt-6 flex w-full flex-col gap-2">
        {EMPTY_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-md border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
