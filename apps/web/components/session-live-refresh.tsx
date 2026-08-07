"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Live-refresh for the Activity page. Polls `/api/state` for the newest
 * session id (Hermes's `shouldRefreshSessions` pattern: the web server
 * and worker are separate processes sharing one DB, so there is no push
 * channel — we detect sessions created elsewhere by their head id) and
 * calls `router.refresh()` only when it changes, so the server-rendered
 * list updates in place without a loading flicker.
 *
 * Renders nothing.
 */
export function SessionLiveRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  const newestRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          recentSessions?: Array<{ id: string }>;
        };
        const newest = data.recentSessions?.[0]?.id ?? null;
        if (newest === null || newest === newestRef.current) return;
        newestRef.current = newest;
        if (!cancelled) router.refresh();
      } catch {
        /* transient — next tick will retry */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, router]);

  return null;
}
