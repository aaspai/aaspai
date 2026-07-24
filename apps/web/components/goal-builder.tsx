"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type PipelineStep = { id: number; value: string };

export function GoalBuilder() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<PipelineStep[]>([
    { id: 1, value: "Define the first deliverable" },
  ]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/company/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          projectTitle,
          description,
          steps: steps.map((step) => step.value),
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not create goal");
      setMessage("Goal and dependency pipeline created.");
      setTitle("");
      setDescription("");
      router.refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not create goal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="goal-title">Goal</Label>
          <Input
            id="goal-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Launch the first customer workflow"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="project-title">Project</Label>
          <Input
            id="project-title"
            value={projectTitle}
            onChange={(event) => setProjectTitle(event.target.value)}
            placeholder="Customer launch"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="goal-description">Outcome</Label>
        <Textarea
          id="goal-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What does success look like?"
        />
      </div>
      <div className="space-y-2">
        <Label>Pipeline steps</Label>
        {steps.map((step, index) => (
          <Input
            key={step.id}
            value={step.value}
            onChange={(event) =>
              setSteps(
                steps.map((current, stepIndex) =>
                  stepIndex === index ? { ...current, value: event.target.value } : current,
                ),
              )
            }
            aria-label={`Pipeline step ${index + 1}`}
          />
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSteps([...steps, { id: steps.length + 1, value: "" }])}
        >
          Add step
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      <Button disabled={busy}>{busy ? "Creating…" : "Create goal pipeline"}</Button>
    </form>
  );
}
