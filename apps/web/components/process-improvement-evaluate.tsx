"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function ProcessImprovementEvaluate() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function evaluate() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/knowledge/evaluate", { method: "POST" });
      const body = (await response.json()) as {
        data?: { createdProposalIds: string[] };
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Evaluation failed");
      setMessage(`${body.data?.createdProposalIds.length ?? 0} review proposals created.`);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Evaluation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={evaluate}>
        {busy ? "Evaluating…" : "Evaluate process improvements"}
      </Button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </div>
  );
}
