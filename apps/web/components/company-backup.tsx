"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CompanyBackup() {
  const [bundle, setBundle] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  async function exportCompany() {
    setMessage(null);
    try {
      const response = await fetch("/api/company/export");
      const body = (await response.json()) as { data?: unknown; error?: string };
      if (!response.ok) return setMessage(body.error ?? "Export failed");
      const text = JSON.stringify(body.data, null, 2);
      setBundle(text);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      link.download = "aaspai-company-export-v2.json";
      link.click();
      URL.revokeObjectURL(link.href);
      setMessage("Company export downloaded.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Export failed");
    }
  }
  async function importCompany() {
    try {
      const parsed = JSON.parse(bundle);
      const valid = await fetch("/api/company/import/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const validation = (await valid.json()) as { error?: string };
      if (!valid.ok) throw new Error(validation.error ?? "Invalid export");
      const applied = await fetch("/api/company/import/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const result = (await applied.json()) as { error?: string };
      if (!applied.ok) throw new Error(result.error ?? "Import failed");
      setMessage("Company restored. Reloading…");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed");
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={exportCompany}>
          Download full company export
        </Button>
        <Button type="button" variant="outline" disabled={!bundle.trim()} onClick={importCompany}>
          Restore into empty company
        </Button>
      </div>
      <textarea
        value={bundle}
        onChange={(event) => setBundle(event.target.value)}
        placeholder="Paste a version 2 company export to validate and restore."
        className="min-h-40 w-full rounded-md border bg-background p-3 font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">
        Restore preserves IDs and evidence, so the target company must be empty.
      </p>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
