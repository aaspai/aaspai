import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getObserverTrace } from "@/lib/observer";

export const dynamic = "force-dynamic";

export default async function ObserverTraceDetailPage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;
  const spans = getObserverTrace(traceId);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trace</h1>
          <p className="font-mono text-xs text-muted-foreground">{traceId}</p>
        </div>
        <Link href="/observer/traces" className="text-xs text-primary hover:underline">
          ← Traces
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Spans ({spans.length})</CardTitle>
          <CardDescription>
            Parent/child relationships preserved; orphan spans remain visible.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {spans.length === 0 ? (
            <p className="text-sm text-muted-foreground">No spans found for this trace.</p>
          ) : (
            <div className="space-y-1 font-mono text-xs">
              {spans.map((span) => {
                const parent = span.parentSpanId ? String(span.parentSpanId) : null;
                const depth = parent ? 1 : 0;
                return (
                  <div
                    key={String(span.spanId)}
                    className={`flex items-center gap-2 rounded border p-2 ${depth ? "ml-6 bg-accent/30" : ""}`}
                  >
                    <Badge
                      variant={
                        span.status === "error"
                          ? "destructive"
                          : span.status === "ok"
                            ? "default"
                            : "outline"
                      }
                    >
                      {String(span.status ?? "unset")}
                    </Badge>
                    <span className="truncate">{String(span.name ?? "")}</span>
                    <span className="ml-auto text-muted-foreground">
                      {span.parentSpanId
                        ? `parent=${String(span.parentSpanId).slice(0, 10)}`
                        : "root"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
