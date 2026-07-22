import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getStateSnapshot, isAaspaiWorkspace, workspaceRoot } from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function StatePage() {
  if (!isAaspaiWorkspace()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No aaspai workspace</CardTitle>
          <CardDescription>
            The current working directory ({workspaceRoot()}) is not an aaspai project.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const state = await getStateSnapshot();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">State</h1>
        <p className="text-sm text-muted-foreground">
          The full operational state of your aaspai project.
        </p>
      </header>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label="Agents" value={state.counts.agents} />
        <Counter label="Sessions" value={state.counts.sessions} />
        <Counter label="Wakeups queued" value={state.counts.wakeups.queued} />
        <Counter label="Wakeups running" value={state.counts.wakeups.running} />
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent sessions</CardTitle>
            <CardDescription>Newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {state.recentSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sessions yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {state.recentSessions.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 rounded-md border bg-background/50 px-3 py-2"
                  >
                    <div className="min-w-0">
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
                      <span className="ml-2 text-xs text-muted-foreground">
                        {s.agentId} · {s.adapter}
                      </span>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <div>{formatRelative(s.startedAt)}</div>
                      {s.durationMs != null && <div className="tabular-nums">{s.durationMs}ms</div>}
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
              <p className="text-sm text-muted-foreground">No wakeups yet.</p>
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
                    <code className="text-[10px] text-muted-foreground/70">
                      {w.id.slice(0, 16)}…
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
