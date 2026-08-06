import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getObserverMetricNames, getObserverMetricSeries } from "@/lib/observer";

export const dynamic = "force-dynamic";

export default async function ObserverMetricsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const selected = typeof sp.name === "string" ? sp.name : undefined;
  const names = getObserverMetricNames();
  const series = selected ? getObserverMetricSeries(selected, 60) : null;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
          <p className="text-sm text-muted-foreground">{names.length} metric names observed.</p>
        </div>
        <Link href="/observer" className="text-xs text-primary hover:underline">
          ← Overview
        </Link>
      </header>

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Metric names</CardTitle>
          </CardHeader>
          <CardContent>
            {names.length === 0 ? (
              <p className="text-sm text-muted-foreground">No metrics yet.</p>
            ) : (
              <nav className="space-y-1">
                {names.map((name) => (
                  <Link
                    key={name}
                    href={`/observer/metrics?name=${encodeURIComponent(name)}`}
                    className={`block truncate rounded px-2 py-1 font-mono text-xs hover:bg-accent ${
                      selected === name ? "bg-accent" : ""
                    }`}
                  >
                    {name}
                  </Link>
                ))}
              </nav>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Time series</CardTitle>
            <CardDescription>
              {selected ? `Last 24h for ${selected}` : "Select a metric name."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!series ? (
              <p className="text-sm text-muted-foreground">No data.</p>
            ) : (
              <div className="space-y-4">
                {series.series.map((s) => (
                  <div key={s.label}>
                    <div className="mb-1 text-xs font-medium">{s.label}</div>
                    <div className="flex h-24 items-end gap-px overflow-hidden">
                      {s.points.map((p) => (
                        <div
                          key={p.timestamp}
                          title={`${new Date(p.timestamp).toISOString()} → ${p.value}`}
                          className="min-w-[2px] flex-1 rounded-t bg-primary/70"
                          style={{ height: barHeight(p.value, s.points) }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function barHeight(value: number | null, points: Array<{ value: number | null }>): string {
  if (value === null) return "0%";
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  return `${Math.max(2, Math.round((value / max) * 100))}%`;
}
