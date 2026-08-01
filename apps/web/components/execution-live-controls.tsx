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
          variant="destructive"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await fetch(`/api/execution/attempts/${encodeURIComponent(attemptId)}/cancel`, {
                method: "POST",
              });
              router.refresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Interrupting…" : "Interrupt"}
        </Button>
      )}
    </div>
  );
}
