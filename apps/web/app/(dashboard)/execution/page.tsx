import Link from "next/link";
import { RunReadyWork } from "@/components/run-ready-work";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAaspaiWorkspace, listExecutionAttempts, listExecutionGoalProgress } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function ExecutionPage() {
  if (!isAaspaiWorkspace()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No aaspai workspace</CardTitle>
          <CardDescription>Initialize a workspace to inspect execution history.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const attempts = await listExecutionAttempts();
  const goals = await listExecutionGoalProgress();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Execution</h1>
        <p className="text-sm text-muted-foreground">
          Attempts, workspaces, events, and artifacts.
        </p>
      </header>
      {goals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Goal progress</CardTitle>
            <CardDescription>
              Evidence-backed progress from WorkItem state; blocked work stays visible.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {goals.map((goal) => (
              <div key={goal.id} className="space-y-2">
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="font-medium">{goal.title}</span>
                  <span className="text-muted-foreground">
                    {goal.percent}% · {goal.completed}/{goal.total} completed
                  </span>
                </div>
                {goal.ready > 0 && (
                  <div className="pt-2">
                    <RunReadyWork goalId={goal.id} />
                  </div>
                )}
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${goal.percent}%` }}
                  />
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>{goal.active} active</span>
                  <span>{goal.proposed} waiting</span>
                  <span>{goal.ready} ready</span>
                  <span>{goal.blocked} blocked</span>
                  <span>{goal.failed} failed</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Agent attempts</CardTitle>
          <CardDescription>
            Newest first. Select an attempt to inspect complete lineage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {attempts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No execution attempts yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2">Agent</th>
                    <th className="px-2 py-2">Harness</th>
                    <th className="px-2 py-2">Work item</th>
                    <th className="px-2 py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((attempt) => (
                    <tr key={attempt.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="px-2 py-2">
                        <Link href={`/execution/attempts/${encodeURIComponent(attempt.id)}`}>
                          <Badge
                            variant={
                              attempt.status === "succeeded"
                                ? "default"
                                : attempt.status === "failed"
                                  ? "destructive"
                                  : "secondary"
                            }
                          >
                            {attempt.status}
                          </Badge>
                        </Link>
                      </td>
                      <td className="px-2 py-2">{attempt.agentId}</td>
                      <td className="px-2 py-2 text-muted-foreground">{attempt.harness}</td>
                      <td className="px-2 py-2 font-mono text-xs">{attempt.workItemId}</td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {attempt.createdAt}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
