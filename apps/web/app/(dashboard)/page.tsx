import { Bot, Database, ScrollText, Sparkles } from "lucide-react";
import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getStateSnapshot, isAaspaiWorkspace, workspaceRoot } from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const state = await getStateSnapshot();

  if (!state.ok || !isAaspaiWorkspace()) {
    return <NoWorkspaceCard />;
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Your AI agent workforce at a glance.
          </p>
        </div>
        <Button asChild>
          <Link href="/chat/agent/ceo">Talk to the CEO</Link>
        </Button>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Agents"
          value={state.counts.agents}
          icon={Bot}
          description="active employees"
          href="/agents"
        />
        <StatCard
          title="Sessions"
          value={state.counts.sessions}
          icon={ScrollText}
          description="total runs"
          href="/sessions"
        />
        <StatCard
          title="Queued wakeups"
          value={state.counts.wakeups.queued}
          icon={Database}
          description="waiting to run"
        />
        <StatCard
          title="Completed"
          value={state.counts.wakeups.completed}
          icon={Sparkles}
          description="successful runs"
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent sessions</CardTitle>
            <CardDescription>The 10 most recent agent runs.</CardDescription>
          </CardHeader>
          <CardContent>
            {state.recentSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No sessions yet. Run{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  aaspai session start --agent agent/ceo --prompt &quot;hello&quot;
                </code>{" "}
                to create one.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {state.recentSessions.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 rounded-md border bg-background/50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            s.status === "succeeded"
                              ? "default"
                              : s.status === "failed"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {s.status}
                        </Badge>
                        <span className="font-medium tabular-nums">
                          {s.agentId.replace(/^agent\//, "")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          via {s.adapter}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {s.id}
                      </p>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      <div>{formatRelative(s.startedAt)}</div>
                      {s.durationMs != null && (
                        <div className="tabular-nums">{s.durationMs}ms</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent wakeups</CardTitle>
            <CardDescription>Work scheduled by loops.</CardDescription>
          </CardHeader>
          <CardContent>
            {state.recentWakeups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No wakeups yet. Loops enqueue work here when they fire.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {state.recentWakeups.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between gap-3 rounded-md border bg-background/50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <Badge variant="secondary">{w.status}</Badge>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {w.reason ?? w.loopId}
                      </span>
                    </div>
                    <code className="shrink-0 text-[10px] text-muted-foreground/80">
                      {w.id.slice(0, 16)}…
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function StatCard({
  title,
  value,
  description,
  icon: Icon,
  href,
}: {
  title: string;
  value: string | number;
  description: string;
  icon: typeof Bot;
  href?: string;
}) {
  const body = (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground/80">{description}</p>
        </div>
        <div className="rounded-md bg-muted/60 p-2.5 text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
  if (!href) return body;
  return (
    <Link href={href} className="block transition-opacity hover:opacity-80">
      {body}
    </Link>
  );
}

function NoWorkspaceCard() {
  const cwd = workspaceRoot();
  return (
    <Card>
      <CardHeader>
        <CardTitle>No aaspai workspace here</CardTitle>
        <CardDescription>
          The web app reads from a single workspace directory. The current
          working directory is{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{cwd}</code> and it
          does not contain an aaspai project.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          To use the web UI, you need an aaspai project. Either:
        </p>
        <ol className="list-inside list-decimal space-y-2 text-sm">
          <li>
            <strong>Run the CLI first</strong> in your project:
            <pre className="mt-2 rounded-md bg-muted p-3 text-xs">
{`cd /path/to/your/project
aaspai init
aaspai db migrate`}
            </pre>
          </li>
          <li>
            <strong>Or set the workspace explicitly</strong> with the{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              AASPAI_CWD
            </code>{" "}
            env var when starting the web server:
            <pre className="mt-2 rounded-md bg-muted p-3 text-xs">
{`AASPAI_CWD=/path/to/your/project npm run dev`}
            </pre>
          </li>
        </ol>
        <Separator />
        <p className="text-xs text-muted-foreground">
          In production (SaaS), each user has their own workspace; the
          picker above is replaced with a multi-tenant dashboard.
        </p>
      </CardContent>
    </Card>
  );
}
