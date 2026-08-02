"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ProjectCommandForm({
  objectives,
}: {
  objectives: Array<{ id: string; title: string }>;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [goalId, setGoalId] = useState(objectives[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch("/api/company/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "create_project",
        title,
        goalId,
        description: "",
        idempotencyKey: `project:${title.toLowerCase()}`,
      }),
    });
    if (!response.ok)
      setError(((await response.json()) as { error?: string }).error ?? "Project creation failed");
    else {
      setTitle("");
      router.refresh();
    }
    setBusy(false);
  }
  if (!objectives.length) return null;
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="New project"
        required
      />
      <select
        value={goalId}
        onChange={(event) => setGoalId(event.target.value)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        {objectives.map((objective) => (
          <option key={objective.id} value={objective.id}>
            {objective.title}
          </option>
        ))}
      </select>
      <Button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create project"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </form>
  );
}
