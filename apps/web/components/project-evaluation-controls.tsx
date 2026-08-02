"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function ProjectEvaluationControls({
  projectId,
  milestones,
}: {
  projectId: string;
  milestones: Array<{ id: string; title: string; status: string }>;
}) {
  const [evidence, setEvidence] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const evidenceIds = evidence
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  async function command(body: Record<string, unknown>) {
    if (!evidenceIds.length) return setMessage("Add at least one evidence ID first.");
    const response = await fetch("/api/company/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        projectId,
        evidence: evidenceIds,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) return setMessage(result.error ?? "Evaluation failed");
    setMessage("Recorded. Reloading…");
    window.location.reload();
  }
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <p className="font-medium">Acceptance review</p>
        <p className="text-xs text-muted-foreground">
          Projects complete only after every milestone has accepted evidence.
        </p>
      </div>
      <input
        value={evidence}
        onChange={(event) => setEvidence(event.target.value)}
        placeholder="Evidence IDs, comma separated"
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        {milestones
          .filter((milestone) => milestone.status !== "accepted")
          .map((milestone) => (
            <Button
              key={milestone.id}
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                void command({
                  type: "record_milestone_evaluation",
                  milestoneId: milestone.id,
                  status: "accepted",
                  rationale: `Evidence accepts ${milestone.title}.`,
                })
              }
            >
              Accept {milestone.title}
            </Button>
          ))}
        <Button type="button" size="sm" onClick={() => void command({ type: "evaluate_project" })}>
          Evaluate project
        </Button>
      </div>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
