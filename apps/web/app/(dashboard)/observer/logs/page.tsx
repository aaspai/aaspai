import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { queryObserverLogs } from "@/lib/observer";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ObserverLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const search = typeof sp.search === "string" ? sp.search : undefined;
  const provider = typeof sp.provider === "string" ? sp.provider : undefined;
  const severity = typeof sp.severity === "string" ? sp.severity : undefined;
  const sessionId = typeof sp.sessionId === "string" ? sp.sessionId : undefined;
  const result = queryObserverLogs({ search, provider, severity, sessionId, limit: 100 });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Logs explorer</h1>
          <p className="text-sm text-muted-foreground">
            {result.total ?? result.rows.length} matching records.
          </p>
        </div>
        <Link href="/observer" className="text-xs text-primary hover:underline">
          ← Overview
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>Server-side filtering on the stored canonical model.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap gap-2 text-sm" method="get">
            <input
              name="search"
              defaultValue={search}
              placeholder="Search body / attributes"
              className="rounded border bg-background px-2 py-1"
            />
            <input
              name="provider"
              defaultValue={provider}
              placeholder="provider"
              className="rounded border bg-background px-2 py-1"
            />
            <input
              name="severity"
              defaultValue={severity}
              placeholder="severity (INFO/ERROR…)"
              className="rounded border bg-background px-2 py-1"
            />
            <input
              name="sessionId"
              defaultValue={sessionId}
              placeholder="session id"
              className="rounded border bg-background px-2 py-1"
            />
            <button type="submit" className="rounded bg-primary px-3 py-1 text-primary-foreground">
              Filter
            </button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Logs</CardTitle>
        </CardHeader>
        <CardContent>
          {result.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No logs match. Try importing or running a session first.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2">Time</th>
                    <th className="px-2 py-2">Provider</th>
                    <th className="px-2 py-2">Severity</th>
                    <th className="px-2 py-2">Body</th>
                    <th className="px-2 py-2">Session</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((log) => (
                    <tr key={String(log.id)} className="border-b last:border-0">
                      <td className="px-2 py-2 whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                        {formatRelative(String(log.observedAt))}
                      </td>
                      <td className="px-2 py-2">
                        <Badge variant="secondary">{String(log.provider)}</Badge>
                      </td>
                      <td className="px-2 py-2">
                        <Badge
                          variant={
                            String(log.severityText ?? "") === "ERROR" ||
                            String(log.severityText ?? "") === "FATAL"
                              ? "destructive"
                              : String(log.severityText ?? "") === "WARN"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {String(log.severityText ?? "INFO")}
                        </Badge>
                      </td>
                      <td className="max-w-xl truncate px-2 py-2 text-muted-foreground">
                        {String(log.body ?? "") || String(log.eventName ?? "")}
                      </td>
                      <td className="px-2 py-2 font-mono text-[10px] text-muted-foreground">
                        {log.sessionId ? String(log.sessionId).slice(0, 12) : "—"}
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
