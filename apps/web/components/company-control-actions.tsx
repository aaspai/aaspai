"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CompanyControlActions({ lifecycleStatus }: { lifecycleStatus: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const type =
    lifecycleStatus === "draft"
      ? "validate_company"
      : lifecycleStatus === "validated"
        ? "start_discovery"
        : lifecycleStatus === "review"
          ? "activate_company"
          : null;
  if (!type) return null;
  async function run() {
    setBusy(true);
    setError("");
    const response = await fetch("/api/company/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, approved: type === "activate_company" }),
    });
    if (!response.ok)
      setError(((await response.json()) as { error?: string }).error ?? "Command failed");
    else router.refresh();
    setBusy(false);
  }
  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button onClick={run} disabled={busy}>
        {busy
          ? "Working…"
          : type === "validate_company"
            ? "Validate company"
            : type === "start_discovery"
              ? "Start CEO discovery"
              : "Approve & activate"}
      </Button>
    </div>
  );
}
