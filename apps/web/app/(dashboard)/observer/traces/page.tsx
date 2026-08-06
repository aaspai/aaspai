import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { queryObserverTraces } from "@/lib/observer";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ObserverTracesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const search = typeof sp.search === "string" ? sp.search : undefined;
  const result = queryObserverTraces({ search, limit: 100 });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Traces</h1>
          <p className="text-sm text-muted-foreground">Span groups by trace id.</p>
        </div>
        <Link href="/observer" className="text-xs text-primary hover:underline">
          ← Overview
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex gap-2 text-sm" method="get">
            <input
              name="search"
              defaultValue={search}
              placeholder="Search span name / attributes"
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
          <CardTitle className="text-base">Trace overviews</CardTitle>
        </CardHeader>
        <CardContent>
          {result.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No traces observed yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2">Trace ID</th>
                    <th className="px-2 py-2">Root span</th>
                    <th className="px-2 py-2">Service</th>
                    <th className="px-2 py-2 text-right">Spans</th>
                    <th className="px-2 py-2 text-right">Duration</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2">Start</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((t) => (
                    <tr key={String(t.traceId)} className="border-b last:border-0">
                      <td className="px-2 py-2">
                        <Link
                          href={`/observer/traces/${encodeURIComponent(String(t.traceId))}`}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {String(t.traceId).slice(0, 16)}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">
                        {String(t.rootSpan ?? "")}
                      </td>
                      <td className="px-2 py-2">
                        <Badge variant="secondary">{String(t.serviceName ?? "")}</Badge>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{Number(t.spanCount)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                        {Number(t.durationMs) > 0 ? `${Number(t.durationMs)}ms` : "—"}
                      </td>
                      <td className="px-2 py-2">
                        <Badge
                          variant={
                            t.status === "error"
                              ? "destructive"
                              : t.status === "ok"
                                ? "default"
                                : "outline"
                          }
                        >
                          {String(t.status ?? "unset")}
                        </Badge>
                      </td>
                      <td className="px-2 py-2 font-mono text-[11px] text-muted-foreground">
                        {formatRelative(String(t.startTime))}
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
