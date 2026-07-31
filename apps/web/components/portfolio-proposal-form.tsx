"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PortfolioProposalForm({ goalId }: { goalId: string | undefined }) {
  const router = useRouter();
  const [summary, setSummary] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!goalId) return null;
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        const response = await fetch("/api/company/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "submit_portfolio_proposal",
            summary,
            evidence: ["founder/discovery-review"],
            projects: project ? [{ goalId, title: project }] : [],
            idempotencyKey: `portfolio:${summary}`,
          }),
        });
        if (!response.ok)
          setError(((await response.json()) as { error?: string }).error ?? "Proposal failed");
        else router.refresh();
        setBusy(false);
      }}
    >
      <Input
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        placeholder="Discovery recommendation"
        required
        className="min-w-64 flex-1"
      />
      <Input
        value={project}
        onChange={(event) => setProject(event.target.value)}
        placeholder="First proposed project (optional)"
        className="min-w-56"
      />
      <Button type="submit" disabled={busy}>
        {busy ? "Submitting…" : "Submit for approval"}
      </Button>
      {error && <span className="self-center text-xs text-destructive">{error}</span>}
    </form>
  );
}
