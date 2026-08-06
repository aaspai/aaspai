"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

/**
 * Live observer indicator. Connects to the observer SSE stream and
 * refreshes the page when new telemetry arrives. Shows connected /
 * disconnected state so stale UI is explicit (plan §9.4).
 */
export function ObserverLiveIndicator() {
  const router = useRouter();
  const [live, setLive] = useState<"connecting" | "live" | "disconnected">("connecting");

  useEffect(() => {
    const source = new EventSource("/api/observer/stream");
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    source.onopen = () => setLive("live");
    source.addEventListener("update", () => {
      setLive("live");
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => router.refresh(), 800);
    });
    source.onerror = () => setLive("disconnected");
    return () => {
      source.close();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [router]);

  const variant = live === "live" ? "default" : live === "connecting" ? "secondary" : "destructive";

  return (
    <Badge variant={variant} className="gap-1">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          live === "live" ? "bg-green-500" : live === "connecting" ? "bg-yellow-500" : "bg-red-500"
        }`}
        aria-hidden
      />
      {live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Disconnected"}
    </Badge>
  );
}
