"use client";

import { MessagesSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentAvatar,
  ConversationSidebar,
  type ConversationSummary,
  type InboxAgent,
} from "@/components/inbox/conversation-sidebar";
import { ConversationThread, type RuntimeOption } from "@/components/inbox/conversation-thread";
import { cn } from "@/lib/utils";

interface Thread {
  /** `t:<rootId>` for a saved conversation, `new:<agentId>` for a draft. */
  key: string;
  agentId: string;
  /** Root session id once the conversation is persisted, else null. */
  conversationId: string | null;
  busy: boolean;
}

/**
 * Claude/ChatGPT-style inbox: a conversation sidebar on the left, the
 * active thread's transcript + composer on the right. Threads stay
 * mounted (hidden when inactive) so streams and `useChat` state survive
 * switching. `?agent=<id>` deep-links an agent; `?t=<rootId>` opens a
 * saved conversation.
 */
export function InboxWorkspace({
  agents,
  runtimes,
  agentId,
  conversationId,
}: {
  agents: InboxAgent[];
  runtimes: RuntimeOption[];
  /** Deep-link agent from `?agent=`. */
  agentId?: string;
  /** Deep-link conversation from `?t=`. */
  conversationId?: string;
}) {
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [agentUp, setAgentUp] = useState<Record<string, boolean>>({});
  const agentUpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const threadsRef = useRef<Thread[]>([]);
  threadsRef.current = threads;

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const loadConversations = useCallback(() => {
    fetch(
      `/api/inbox/conversations?limit=100${
        filterAgent !== "all" ? `&agentId=${encodeURIComponent(filterAgent)}` : ""
      }`,
      { cache: "no-store" },
    )
      .then((r) =>
        r.ok ? (r.json() as Promise<{ conversations: ConversationSummary[] }>) : Promise.reject(r),
      )
      .then((data) => setConversations(data.conversations))
      .catch(() => undefined);
  }, [filterAgent]);

  // Load the conversation list on mount and when the agent filter changes.
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Live status polling for the thread header (single stable interval).
  useEffect(() => {
    const poll = () => {
      const openIds = [...new Set(threadsRef.current.map((t) => t.agentId))];
      if (openIds.length === 0) return;
      for (const id of openIds) {
        fetch(`/api/agents/status?agentId=${encodeURIComponent(id)}`)
          .then((r) => (r.ok ? (r.json() as Promise<{ up: boolean }>) : Promise.reject(r)))
          .then((data) =>
            setAgentUp((prev) => (prev[id] === data.up ? prev : { ...prev, [id]: data.up })),
          )
          .catch(() => undefined);
      }
    };
    poll();
    agentUpTimerRef.current = setInterval(poll, 30_000);
    return () => {
      if (agentUpTimerRef.current) clearInterval(agentUpTimerRef.current);
    };
  }, []);

  const syncUrl = useCallback(
    (t: Thread) => {
      const params = new URLSearchParams();
      params.set("agent", t.agentId.startsWith("agent/") ? t.agentId : `agent/${t.agentId}`);
      if (t.conversationId) params.set("t", t.conversationId);
      router.replace(`/inbox?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  const openThread = useCallback(
    (agent: InboxAgent, conversationId: string | null) => {
      const key = conversationId ? `t:${conversationId}` : `new:${agent.id}`;
      const existing = threadsRef.current.find((t) => t.key === key);
      const next: Thread = existing ?? { key, agentId: agent.id, conversationId, busy: false };
      if (!existing) {
        setThreads((prev) => [...prev, next]);
      }
      setActiveKey(key);
      syncUrl(next);
    },
    [syncUrl],
  );

  const startNewChat = useCallback(() => {
    // New chat needs a target agent — the first available agent.
    const agent = agents[0];
    if (!agent) return;
    openThread(agent, null);
  }, [agents, openThread]);

  const openConversation = useCallback(
    (conversation: ConversationSummary) => {
      const agent = agentById.get(conversation.agentId);
      if (!agent) return;
      openThread(agent, conversation.id);
    },
    [agentById, openThread],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      fetch(`/api/inbox/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
        .then(() => {
          setConversations((prev) => prev.filter((c) => c.id !== id));
          // Close the thread if it's the deleted conversation.
          const key = `t:${id}`;
          const openThreads = threadsRef.current;
          const existing = openThreads.find((t) => t.key === key);
          if (existing) {
            setThreads((prev) => prev.filter((t) => t.key !== key));
            if (activeKey === key) {
              const remaining = openThreads.filter((t) => t.key !== key);
              const next = remaining[remaining.length - 1] ?? null;
              setActiveKey(next?.key ?? null);
              if (next) syncUrl(next);
              else router.replace("/inbox", { scroll: false });
            }
          }
        })
        .catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeKey, syncUrl, router],
  );

  // Deep-link handling: `?agent=` + `?t=` open a thread when they change.
  useEffect(() => {
    if (!agentId) return;
    const normalized = agentId.startsWith("agent/") ? agentId : `agent/${agentId}`;
    const agent = agentById.get(normalized);
    if (!agent) return;
    const existing = conversationId
      ? threadsRef.current.find((t) => t.key === `t:${conversationId}`)
      : threadsRef.current.find((t) => t.key === `new:${normalized}`);
    if (existing) {
      setActiveKey(existing.key);
      return;
    }
    openThread(agent, conversationId ?? null);
  }, [agentId, conversationId, agentById, openThread]);

  const setThreadBusy = useCallback((key: string, busy: boolean) => {
    setThreads((prev) => prev.map((t) => (t.key === key ? { ...t, busy } : t)));
  }, []);

  const handleSessionCreated = useCallback(
    (key: string, sessionId: string) => {
      // A draft thread just produced its first turn: it's now a real
      // conversation. Rewrite the key to `t:<rootId>` and refresh the list.
      const existing = threadsRef.current.find((t) => t.key === key);
      if (!existing || existing.conversationId) return;
      const nextKey = `t:${sessionId}`;
      setThreads((prev) =>
        prev.map((t) => (t.key === key ? { ...t, key: nextKey, conversationId: sessionId } : t)),
      );
      if (activeKey === key) {
        setActiveKey(nextKey);
        syncUrl({ ...existing, key: nextKey, conversationId: sessionId });
      }
      loadConversations();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeKey, syncUrl, loadConversations],
  );

  const activeThread = threads.find((t) => t.key === activeKey) ?? null;

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden rounded-xl border bg-background">
      {/* Conversation sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r bg-card/50">
        <ConversationSidebar
          agents={agents}
          conversations={conversations}
          activeId={activeThread?.conversationId ?? null}
          filterAgent={filterAgent}
          onSelect={openConversation}
          onNewChat={startNewChat}
          onDelete={deleteConversation}
          onFilterAgent={(a) => setFilterAgent(a)}
        />
      </aside>

      {/* Conversation pane */}
      <main className="flex min-w-0 flex-1 flex-col">
        {threads.length === 0 ? (
          <EmptyState
            agents={agents}
            agentUp={agentUp}
            onPick={(agent) => openThread(agent, null)}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            {threads.map((thread) => {
              const agent = agentById.get(thread.agentId);
              if (!agent) return null;
              const active = thread.key === activeKey;
              return (
                <div
                  key={thread.key}
                  className={cn("h-full min-w-0 min-h-0 flex-col", active ? "flex" : "hidden")}
                >
                  <ThreadHeader
                    agent={agent}
                    busy={thread.busy}
                    up={agentUp[agent.id] ?? false}
                    onClose={() => {
                      setThreads((prev) => prev.filter((t) => t.key !== thread.key));
                      if (activeKey === thread.key) {
                        const remaining = threads.filter((t) => t.key !== thread.key);
                        const next = remaining[remaining.length - 1] ?? null;
                        setActiveKey(next?.key ?? null);
                        if (next) syncUrl(next);
                        else router.replace("/inbox", { scroll: false });
                      }
                    }}
                  />
                  <div className="flex min-h-0 flex-1 flex-col">
                    <ConversationThread
                      agentId={agent.id}
                      agentTitle={agent.title}
                      adapter={agent.adapter}
                      model={agent.model ?? null}
                      runtimes={runtimes}
                      defaultRuntime={
                        (agent.runtime as { default?: Record<string, unknown> } | undefined)
                          ?.default ?? null
                      }
                      conversationId={thread.conversationId}
                      onBusyChange={(busy) => setThreadBusy(thread.key, busy)}
                      onSessionCreated={(sessionId) => handleSessionCreated(thread.key, sessionId)}
                      onConversationUpdated={loadConversations}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function ThreadHeader({
  agent,
  busy,
  up,
  onClose,
}: {
  agent: InboxAgent;
  busy: boolean;
  up: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2.5">
      <AgentAvatar agent={agent} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{agent.title}</span>
          <LiveDot state={busy ? "busy" : up ? "up" : "down"} />
        </div>
        <p className="truncate text-xs text-muted-foreground">{agent.model ?? "default model"}</p>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="Close chat"
        aria-label="Close chat"
      >
        <MessagesSquare className="h-4 w-4 rotate-45" />
      </button>
    </div>
  );
}

function LiveDot({ state }: { state: "busy" | "up" | "down" }) {
  return (
    <span
      title={state === "busy" ? "Running now" : state === "up" ? "Sandbox live" : "Idle"}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        state === "busy" && "animate-pulse bg-emerald-500",
        state === "up" && "bg-emerald-500/70",
        state === "down" && "bg-muted-foreground/40",
      )}
    />
  );
}

function EmptyState({
  agents,
  agentUp,
  onPick,
}: {
  agents: InboxAgent[];
  agentUp: Record<string, boolean>;
  onPick: (agent: InboxAgent) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-primary">
        <MessagesSquare className="h-6 w-6" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold">Start a conversation</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick an agent below, or select a past conversation from the sidebar.
        </p>
      </div>
      <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => onPick(agent)}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/40"
          >
            <AgentAvatar agent={agent} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{agent.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {agent.role || agent.adapter}
              </span>
            </span>
            {agentUp[agent.id] && <LiveDot state="up" />}
          </button>
        ))}
      </div>
    </div>
  );
}
