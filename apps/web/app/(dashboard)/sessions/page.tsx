import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { isAaspaiWorkspace, listRecentSessions } from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
  if (!isAaspaiWorkspace()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No aaspai workspace</CardTitle>
          <CardDescription>
            Run <code className="rounded bg-muted px-1 py-0.5 text-xs">aaspai init</code> first.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const sessions = await listRecentSessions(50);
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-sm text-muted-foreground">
          {sessions.length} most recent agent runs.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>All sessions</CardTitle>
          <CardDescription>Newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2">Agent</th>
                    <th className="px-2 py-2">Adapter</th>
                    <th className="px-2 py-2">Started</th>
                    <th className="px-2 py-2 text-right">Duration</th>
                    <th className="px-2 py-2 text-right">id</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b last:border-0 hover:bg-accent/30"
                    >
                      <td className="px-2 py-2">
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
                      </td>
                      <td className="px-2 py-2">
                        <Link
                          href={`/agents/${encodeURIComponent(s.agentId)}`}
                          className="hover:underline"
                        >
                          {s.agentId.replace(/^agent\//, "")}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {s.adapter}
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {formatRelative(s.startedAt)}
                      </td>
                      <td className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">
                        {s.durationMs != null ? `${s.durationMs}ms` : "—"}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-[10px] text-muted-foreground/70">
                        {s.id.slice(0, 16)}…
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
