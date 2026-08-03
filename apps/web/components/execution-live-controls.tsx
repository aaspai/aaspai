"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "lost"]);

export function ExecutionLiveControls({
  attemptId,
  status,
}: {
  attemptId: string;
  status: string;
}) {
  const router = useRouter();
  const [connection, setConnection] = useState(TERMINAL.has(status) ? "complete" : "connecting");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (TERMINAL.has(status)) return;
    const source = new EventSource(
      `/api/execution/attempts/${encodeURIComponent(attemptId)}/stream`,
    );
    source.onopen = () => setConnection("connected");
    source.addEventListener("update", () => router.refresh());
    source.onerror = () => setConnection("reconnecting");
    return () => source.close();
  }, [attemptId, router, status]);

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline">live: {connection}</Badge>
      {!TERMINAL.has(status) && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const response = await fetch(
                `/api/execution/attempts/${encodeURIComponent(attemptId)}/interrupt`,
                { method: "POST" },
              );
              if (!response.ok) {
                const body = (await response.json().catch(() => null)) as {
                  error?: string;
                } | null;
                throw new Error(body?.error ?? `Interrupt failed (${response.status})`);
              }
              router.refresh();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Interrupting…" : "Interrupt & retry"}
        </Button>
      )}
      {error ? (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
