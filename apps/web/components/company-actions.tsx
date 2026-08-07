"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function GiveDirection({ currentObjective }: { currentObjective?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(currentObjective ?? "");
  const [mandate, setMandate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/company/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, mandate }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) return setError(body.error ?? "Could not give direction");
      setOpen(false);
      setMandate("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not give direction");
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <Button onClick={() => setOpen(true)} className="shrink-0">
        Give direction
      </Button>
    );

  return (
    <form onSubmit={submit} className="w-full space-y-3 rounded-lg border bg-background p-4">
      <div className="space-y-1.5">
        <Label htmlFor="direction-objective">Objective</Label>
        <Input
          id="direction-objective"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="direction-mandate">Direction to the CEO</Label>
        <Textarea
          id="direction-mandate"
          value={mandate}
          onChange={(event) => setMandate(event.target.value)}
          placeholder="What changed, what matters now, and any boundaries."
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={busy}>{busy ? "Queuing..." : "Send to CEO"}</Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function DecisionActions({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function decide(status: "approved" | "rejected" | "changes_requested") {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/company/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) return setError(body.error ?? "Decision failed");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Decision failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <Button disabled={busy} onClick={() => decide("approved")}>
          Approve
        </Button>
        <Button disabled={busy} variant="outline" onClick={() => decide("changes_requested")}>
          Request changes
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
