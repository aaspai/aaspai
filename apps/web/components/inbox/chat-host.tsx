"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { InboxAgent } from "@/components/inbox/conversation-sidebar";
import type { RuntimeOption } from "@/components/inbox/conversation-thread";
import { InboxWorkspace } from "@/components/inbox/inbox-workspace";
import { cn } from "@/lib/utils";

interface BootstrapData {
  agents: InboxAgent[];
  runtimes: RuntimeOption[];
}

function ChatHostInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isInbox = pathname === "/inbox";
  const [mounted, setMounted] = useState(isInbox);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(false);
  const activatedRef = useRef(isInbox);
  const agentId = searchParams.get("agent") ?? undefined;
  const conversationId = searchParams.get("t") ?? undefined;

  useEffect(() => {
    activatedRef.current = activatedRef.current || isInbox;
    if (activatedRef.current) setMounted(true);
  }, [isInbox]);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/inbox/bootstrap", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<BootstrapData>) : Promise.reject(r)))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  // Fetch bootstrap once, the first time the host mounts (data guard via
  // a ref so the effect deps stay minimal).
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!mounted || loadedRef.current) return;
    loadedRef.current = true;
    load();
  }, [mounted, load]);

  const noWorkspace = data === null && !loading;

  return (
    <div
      data-chat-active={isInbox ? "true" : "false"}
      aria-hidden={!isInbox}
      className={cn("min-h-0 min-w-0", isInbox ? "flex flex-1 flex-col" : "hidden")}
    >
      {mounted &&
        (loading ? (
          <div className="flex h-[calc(100vh-4rem)] items-center justify-center rounded-xl border bg-background text-sm text-muted-foreground">
            Loading chat…
          </div>
        ) : noWorkspace ? (
          <div className="flex h-[calc(100vh-4rem)] items-center justify-center rounded-xl border bg-background">
            <div className="text-center">
              <p className="text-lg font-semibold">Chats</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Initialize a workspace to chat with your agents.
              </p>
            </div>
          </div>
        ) : data ? (
          <InboxWorkspace
            agents={data.agents}
            runtimes={data.runtimes}
            agentId={agentId}
            conversationId={conversationId}
          />
        ) : null)}
    </div>
  );
}

/**
 * Persistent chat host — Hermes's ChatPage pattern applied to Next App
 * Router. Mounted once in the dashboard layout and kept alive across
 * route changes; visibility is toggled with CSS (`display:none`) when
 * the user is not on `/inbox`, so the `useChat` streams and channel
 * state survive tab switches and page navigation.
 *
 * `useSearchParams` requires a Suspense boundary in Next 15, so the
 * inner component reads the URL while the outer export provides it.
 */
export function ChatHost() {
  return (
    <Suspense fallback={null}>
      <ChatHostInner />
    </Suspense>
  );
}
