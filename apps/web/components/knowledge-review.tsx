"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function KnowledgeReview({
  organizationId,
  proposalId,
}: {
  organizationId: string;
  proposalId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function review(action: "accept" | "reject") {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/knowledge/proposals/${proposalId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          action,
          actorId: "human/company-owner",
          reason:
            action === "accept"
              ? "Reviewed in the company knowledge queue."
              : "Rejected in the company knowledge queue.",
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Review failed");
      setMessage(action === "accept" ? "Accepted; change request created." : "Rejected.");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Review failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" disabled={busy} onClick={() => review("accept")}>
        Accept & create change request
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => review("reject")}
      >
        Reject
      </Button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </div>
  );
}
