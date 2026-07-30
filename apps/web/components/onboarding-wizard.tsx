"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { listFrontendProviders } from "@/lib/provider-status";

type Provider = Awaited<ReturnType<typeof listFrontendProviders>>[number];

export function OnboardingWizard({
  companyName,
  providers,
}: {
  companyName: string;
  providers: Provider[];
}) {
  const router = useRouter();
  const firstReady = providers.find((item) => item.ready)?.type ?? "opencode_cli";
  const [provider, setProvider] = useState(firstReady);
  const selectedProvider = providers.find((item) => item.type === provider) ?? providers[0];
  const [model, setModel] = useState(selectedProvider?.models[0]?.id ?? "");
  const [agenda, setAgenda] = useState("");
  const [instructions, setInstructions] = useState("");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalOutcome, setGoalOutcome] = useState("");
  const [firstPriority, setFirstPriority] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          model,
          ceoAgenda: agenda,
          ceoInstructions: instructions,
          goalTitle,
          goalOutcome,
          firstPriority,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Company setup failed");
      router.push("/company");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Company setup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            aaspai setup
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Put the CEO in the driver's seat
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {companyName} starts with a founder mandate and one CEO. The CEO creates the plan and
            proposes hires only when the work requires them.
          </p>
        </header>

        <form onSubmit={submit} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>1. Choose the CEO's execution engine and model</CardTitle>
              <CardDescription>
                OpenCode runs in Daytona with short-lived gateway credentials. Simulation is not
                used for company work.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {providers.map((item) => (
                  <label
                    key={item.type}
                    className={`cursor-pointer rounded-lg border p-4 transition-colors ${provider === item.type ? "border-primary bg-primary/5" : "bg-card hover:bg-accent/40"}`}
                  >
                    <input
                      type="radio"
                      name="provider"
                      value={item.type}
                      checked={provider === item.type}
                      onChange={() => {
                        setProvider(item.type);
                        setModel(item.models[0]?.id ?? "");
                      }}
                      className="sr-only"
                    />
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{item.label}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{item.type}</p>
                      </div>
                      <Badge variant={item.ready ? "default" : "outline"}>
                        {item.ready
                          ? "Ready"
                          : item.installed
                            ? "Needs attention"
                            : "Not installed"}
                      </Badge>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {item.environment.checks[0]?.message ?? "Available for local execution."}
                    </p>
                  </label>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ceo-model">CEO model</Label>
                <select
                  id="ceo-model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  required
                >
                  {selectedProvider?.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} ({item.id})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  This model becomes the CEO agent's default for every execution.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Define the company</CardTitle>
              <CardDescription>
                These instructions become the CEO's durable company context.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ceo-agenda">Mission</Label>
                <Textarea
                  id="ceo-agenda"
                  value={agenda}
                  onChange={(event) => setAgenda(event.target.value)}
                  placeholder="Build a trusted commerce company for independent makers..."
                  required
                  minLength={10}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ceo-instructions">Principles and boundaries</Label>
                <Textarea
                  id="ceo-instructions"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder="Prioritize customer value, delegate clearly, and never mark work complete without evidence..."
                  required
                  minLength={10}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>3. Set the first measurable objective</CardTitle>
              <CardDescription>
                Give the outcome and immediate priority. The CEO decides how to achieve it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="onboarding-goal">Goal</Label>
                <Input
                  id="onboarding-goal"
                  value={goalTitle}
                  onChange={(event) => setGoalTitle(event.target.value)}
                  placeholder="Launch our first customer workflow"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="onboarding-outcome">What does success look like?</Label>
                <Textarea
                  id="onboarding-outcome"
                  value={goalOutcome}
                  onChange={(event) => setGoalOutcome(event.target.value)}
                  placeholder="Serve the first ten customers with a repeatable process."
                  required
                  minLength={3}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="first-priority">CEO&apos;s first priority</Label>
                <Input
                  id="first-priority"
                  value={firstPriority}
                  onChange={(event) => setFirstPriority(event.target.value)}
                  placeholder="Validate our offer and choose the first client niche"
                  required
                />
              </div>
            </CardContent>
          </Card>

          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <Button className="w-full" disabled={busy}>
            {busy ? "Launching company..." : "Launch company"}
          </Button>
        </form>
      </div>
    </main>
  );
}
