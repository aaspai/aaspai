"use client";

import { ArrowDown, Send, User } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatRelative } from "@/lib/utils";

type Role = "user" | "assistant" | "system";

interface Turn {
  id: string;
  role: Role;
  text: string;
  ts: string;
  status?: "sending" | "done" | "error";
  sessionId?: string;
  error?: string;
}

interface Props {
  agentId: string;
  agentTitle: string;
  adapter: string;
  model: string | null;
}

export function ChatConsole({ agentId, agentTitle, adapter, model }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showScroll, setShowScroll] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScroll(distanceFromBottom > 100);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);

    const userTurn: Turn = {
      id: `t_${Date.now()}_u`,
      role: "user",
      text,
      ts: new Date().toISOString(),
      status: "sending",
    };
    const placeholder: Turn = {
      id: `t_${Date.now()}_a`,
      role: "assistant",
      text: "thinking…",
      ts: new Date().toISOString(),
      status: "sending",
    };
    setTurns((prev) => [...prev, userTurn, placeholder]);

    try {
      const res = await fetch(`/api/chat/${encodeURIComponent(agentId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          adapter,
          model,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { reply: string; sessionId?: string };
      setTurns((prev) => prev.map((t) => (t.id === userTurn.id ? { ...t, status: "done" } : t)));
      setTurns((prev) =>
        prev.map((t) =>
          t.id === placeholder.id
            ? {
                ...t,
                text: data.reply,
                status: "done",
                sessionId: data.sessionId,
              }
            : t,
        ),
      );
    } catch (err) {
      setTurns((prev) =>
        prev.map((t) => (t.id === userTurn.id ? { ...t, status: "error", error: String(err) } : t)),
      );
      setTurns((prev) =>
        prev.map((t) =>
          t.id === placeholder.id
            ? {
                ...t,
                text: `(error: ${String(err)})`,
                status: "error",
              }
            : t,
        ),
      );
    } finally {
      setBusy(false);
      taRef.current?.focus();
    }
  }, [input, busy, agentId, adapter, model]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <Card className="flex flex-1 flex-col overflow-hidden">
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          {turns.length === 0 && (
            <EmptyChat agentTitle={agentTitle} onSuggest={(s) => setInput(s)} />
          )}
          {turns.map((t) => (
            <TurnBubble key={t.id} turn={t} agentTitle={agentTitle} />
          ))}
        </div>
        {showScroll && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 right-3 rounded-full border bg-background/90 p-2 shadow-sm hover:bg-accent"
            title="Scroll to latest"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <CardContent className="border-t p-3">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <Textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={`Message ${agentTitle}… (Enter to send, Shift+Enter for newline)`}
            rows={2}
            disabled={busy}
            className="min-h-[44px] resize-none"
          />
          <Button
            type="button"
            onClick={send}
            disabled={busy || !input.trim()}
            size="icon"
            className="h-11 w-11 shrink-0"
            title="Send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TurnBubble({ turn, agentTitle }: { turn: Turn; agentTitle: string }) {
  const isUser = turn.role === "user";
  const isError = turn.status === "error";
  return (
    <div className={cn("flex w-full gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
            isError ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
          )}
          title={agentTitle}
        >
          {agentTitle
            .split(" ")
            .map((s) => s[0])
            .slice(0, 2)
            .join("")}
        </div>
      )}
      <div
        className={cn(
          "max-w-[80%] rounded-lg border px-3 py-2 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : isError
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "bg-card",
        )}
      >
        <p className="whitespace-pre-wrap">{turn.text}</p>
        <div
          className={cn(
            "mt-1 flex items-center gap-2 text-[10px]",
            isUser ? "text-primary-foreground/60" : "text-muted-foreground",
          )}
        >
          {isUser ? <User className="h-3 w-3" /> : null}
          <span>{formatRelative(turn.ts)}</span>
          {turn.status === "sending" && <span>· sending…</span>}
          {turn.status === "error" && <span>· failed</span>}
          {turn.sessionId && <span className="font-mono">· {turn.sessionId.slice(0, 12)}…</span>}
        </div>
      </div>
      {isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
          you
        </div>
      )}
    </div>
  );
}

function EmptyChat({
  agentTitle,
  onSuggest,
}: {
  agentTitle: string;
  onSuggest: (text: string) => void;
}) {
  const suggestions = [
    "What can you do?",
    "What is everyone working on?",
    "Hire a marketing manager who writes tweets",
    "Assign this to developer: fix the login bug",
  ];
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
        <User className="h-5 w-5" />
      </div>
      <h2 className="text-lg font-semibold">Talk to {agentTitle}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Type a message below. The agent's reply depends on its adapter and the system prompt in{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">AGENT.md</code>.
      </p>
      <div className="mt-6 flex w-full flex-col gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggest(s)}
            className="rounded-md border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
