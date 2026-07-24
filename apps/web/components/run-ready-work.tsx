"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function RunReadyWork({ goalId }: { goalId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState("");
  async function run() {
    setBusy(true);
    setMessage("");
    setSessionId("");
    try {
      const response = await fetch(`/api/company/goals/${encodeURIComponent(goalId)}/run`, {
        method: "POST",
      });
      const body = (await response.json()) as {
        error?: string;
        data?: { result?: { status?: string; logRef?: string } };
      };
      if (!response.ok) throw new Error(body.error ?? "Execution failed");
      const logRef = body.data?.result?.logRef ?? "";
      setMessage(`Execution ${body.data?.result?.status ?? "finished"}. ${logRef}`);
      setSessionId(logRef);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Execution failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={run} disabled={busy}>
        {busy ? "Running…" : "Run ready work"}
      </Button>
      {message && (
        <span role="status" className="text-xs text-muted-foreground">
          {message}
        </span>
      )}
      {sessionId && (
        <Link href={`/sessions/${encodeURIComponent(sessionId)}`} className="text-xs underline">
          Inspect session
        </Link>
      )}
    </div>
  );
}
