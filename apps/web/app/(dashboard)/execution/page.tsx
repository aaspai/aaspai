import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAaspaiWorkspace, listExecutionAttempts } from "@/lib/aaspai";

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
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Execution</h1>
        <p className="text-sm text-muted-foreground">
          Attempts, workspaces, events, and artifacts.
        </p>
      </header>
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
