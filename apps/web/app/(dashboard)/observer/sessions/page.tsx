import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { queryObserverSessions } from "@/lib/observer";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ObserverSessionsPage() {
  const result = queryObserverSessions({ limit: 100 });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Observer sessions</h1>
          <p className="text-sm text-muted-foreground">
            Projected session summaries from observed telemetry.
          </p>
        </div>
        <Link href="/observer" className="text-xs text-primary hover:underline">
          ← Overview
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {result.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No observer sessions yet. Run a session, import provider files, or backfill.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2">Session</th>
                    <th className="px-2 py-2">Provider</th>
                    <th className="px-2 py-2">Model</th>
                    <th className="px-2 py-2 text-right">Messages</th>
                    <th className="px-2 py-2 text-right">Tools</th>
                    <th className="px-2 py-2 text-right">Cost</th>
                    <th className="px-2 py-2">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((s) => (
                    <tr key={String(s.id)} className="border-b last:border-0">
                      <td className="px-2 py-2">
                        <Link
                          href={`/observer/sessions/${encodeURIComponent(String(s.sessionId))}`}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {String(s.sessionId).slice(0, 24)}
                        </Link>
                      </td>
                      <td className="px-2 py-2">
                        <Badge variant="secondary">{String(s.provider)}</Badge>
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {String(s.model ?? "—")}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {Number(s.messageCount ?? 0)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {Number(s.toolCallCount ?? 0)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {s.costUsd != null ? `$${Number(s.costUsd).toFixed(4)}` : "—"}
                      </td>
                      <td className="px-2 py-2 font-mono text-[11px] text-muted-foreground">
                        {formatRelative(String(s.lastSeenAt))}
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
