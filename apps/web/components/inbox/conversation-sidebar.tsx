"use client";

import { Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatRelative } from "@/lib/utils";

export interface InboxAgent {
  id: string;
  title: string;
  role: string;
  adapter: string;
  model: string | null;
  runtime: Record<string, unknown>;
}

export interface ConversationSummary {
  id: string;
  agentId: string;
  title: string;
  updatedAt: string;
  turnCount: number;
  status: string;
}

const AGENT_COLORS = [
  "bg-blue-600",
  "bg-emerald-600",
  "bg-purple-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-cyan-600",
  "bg-indigo-600",
  "bg-teal-600",
];

function agentColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}

export function AgentAvatar({ agent, size = "md" }: { agent: InboxAgent; size?: "sm" | "md" }) {
  const initials = (agent.title || agent.id).slice(0, 1).toUpperCase();
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        agentColor(agent.id),
        size === "sm" ? "h-6 w-6 text-xs" : "h-9 w-9 text-sm",
      )}
    >
      {initials}
    </div>
  );
}

function timeGroup(updatedAt: string): string {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return "Older";
  const now = Date.now();
  const day = 86_400_000;
  const diff = now - t;
  if (diff < day) return "Today";
  if (diff < 2 * day) return "Yesterday";
  if (diff < 7 * day) return "Previous 7 days";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Older"];

function StatusDot({ status }: { status: string }) {
  const live = status === "queued" || status === "running";
  const failed = status === "failed";
  return (
    <span
      title={status}
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        live && "animate-pulse bg-emerald-500",
        failed && "bg-destructive",
        !live && !failed && "bg-muted-foreground/40",
      )}
    />
  );
}

export function ConversationSidebar({
  agents,
  conversations,
  activeId,
  filterAgent,
  onSelect,
  onNewChat,
  onDelete,
  onFilterAgent,
}: {
  agents: InboxAgent[];
  conversations: ConversationSummary[];
  /** Currently-open conversation (root session id) — highlighted. */
  activeId: string | null;
  /** Agent filter — `"all"` or an agent id. */
  filterAgent: string;
  onSelect: (conversation: ConversationSummary) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onFilterAgent: (agentId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations.filter((c) => {
      if (filterAgent !== "all" && c.agentId !== filterAgent) return false;
      if (!q) return true;
      return c.title.toLowerCase().includes(q);
    });
  }, [conversations, filterAgent, query]);

  const groups = useMemo(() => {
    const map = new Map<string, ConversationSummary[]>();
    for (const c of filtered) {
      const g = timeGroup(c.updatedAt);
      const list = map.get(g) ?? [];
      list.push(c);
      map.set(g, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return map;
  }, [filtered]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Chats</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={onNewChat}
            title="New chat"
          >
            <Plus className="h-3.5 w-3.5" />
            New chat
          </Button>
        </div>
        <div className="relative mt-2">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            No conversations{query ? ` match “${query}”` : " yet"}.
          </p>
        ) : (
          GROUP_ORDER.map((group) => {
            const items = groups.get(group);
            if (!items || items.length === 0) return null;
            return (
              <div key={group} className="mb-3">
                <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group}
                </p>
                <ul className="space-y-0.5">
                  {items.map((conversation) => {
                    const agent = agentById.get(conversation.agentId);
                    const active = conversation.id === activeId;
                    return (
                      <li key={conversation.id}>
                        <div
                          className={cn(
                            "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                            active ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => onSelect(conversation)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            {agent ? <AgentAvatar agent={agent} size="sm" /> : null}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">
                                {conversation.title}
                              </span>
                              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <StatusDot status={conversation.status} />
                                <span className="truncate">
                                  {agent?.title ?? conversation.agentId}
                                </span>
                                <span className="shrink-0">
                                  {formatRelative(conversation.updatedAt)}
                                </span>
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(conversation.id)}
                            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                            title="Delete conversation"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t p-2">
        <div className="flex gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => onFilterAgent("all")}
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-xs transition-colors",
              filterAgent === "all"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            All
          </button>
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => onFilterAgent(agent.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors",
                filterAgent === agent.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <AgentAvatar agent={agent} size="sm" />
              {agent.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
