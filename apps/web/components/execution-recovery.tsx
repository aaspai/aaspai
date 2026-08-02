"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Recovery = { queuedWakeups: number; staleClaimedWakeups: number; staleAttempts: number };

async function fetchRecovery(): Promise<Recovery | null> {
  const response = await fetch("/api/company/recovery");
  return response.ok ? ((await response.json()).data ?? null) : null;
}

export function ExecutionRecovery() {
  const [state, setState] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetchRecovery().then(setState);
  }, []);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <span className="text-muted-foreground">
        {state
          ? `${state.queuedWakeups} queued · ${state.staleClaimedWakeups} stale wakes · ${state.staleAttempts} stale attempts`
          : "Loading recovery status…"}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await fetch("/api/company/recovery", { method: "POST" });
            setState(await fetchRecovery());
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Reconciling…" : "Reconcile now"}
      </Button>
    </div>
  );
}
