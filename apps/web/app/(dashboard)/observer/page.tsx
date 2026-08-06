import Link from "next/link";
import { ObserverLiveIndicator } from "@/components/observer-live-indicator";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getObserverOverview, observerAvailable } from "@/lib/observer";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

export default async function ObserverOverviewPage() {
  if (!observerAvailable()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Observer not available</CardTitle>
          <CardDescription>
            Run <code>aaspai init</code> in a workspace first.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const overview = getObserverOverview(20);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Observer</h1>
          <p className="text-sm text-muted-foreground">
            Read-side view of agent telemetry: logs, traces, metrics, sessions, costs, and ingestion
            health.
          </p>
        </div>
        <ObserverLiveIndicator />
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Logs" value={Number(overview.stats.logs ?? 0)} />
        <StatCard label="Traces" value={Number(overview.stats.traces ?? 0)} />
        <StatCard label="Metrics" value={Number(overview.stats.metrics ?? 0)} />
        <StatCard label="Sessions" value={Number(overview.stats.sessions ?? 0)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>Latest observed logs.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.recentLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No telemetry yet. Start a session, import provider files (
                <code>aaspai observe import</code>), or backfill (
                <code>aaspai observe backfill</code>).
              </p>
            ) : (
              overview.recentLogs.map((log) => (
                <div key={String(log.id)} className="flex items-center gap-2 text-sm">
                  <span className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground">
                    {formatRelative(String(log.observedAt))}
                  </span>
                  <Badge variant="secondary">{String(log.provider)}</Badge>
                  <span className="truncate text-muted-foreground">
                    {String(log.body ?? "").slice(0, 140)}
                  </span>
                </div>
              ))
            )}
            <Link href="/observer/logs" className="text-xs text-primary hover:underline">
              Open logs explorer →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ingestion health</CardTitle>
            <CardDescription>Errors, import state, and services.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Services</span>
              <span>{overview.services.join(", ") || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Imported files</span>
              <span>{overview.importFiles}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ingestion errors</span>
              <span className={overview.ingestErrors.length ? "text-destructive" : ""}>
                {overview.ingestErrors.length}
              </span>
            </div>
            {overview.ingestErrors.length > 0 && (
              <div className="space-y-1 border-t pt-2">
                {overview.ingestErrors.slice(0, 4).map((e) => (
                  <div key={String(e.id)} className="text-xs text-muted-foreground">
                    <span className="font-mono text-destructive">{String(e.kind)}</span> —{" "}
                    {String(e.message)}
                  </div>
                ))}
              </div>
            )}
            <Link
              href="/observer/imports"
              className="inline-block text-xs text-primary hover:underline"
            >
              View import status →
            </Link>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent sessions</CardTitle>
          <CardDescription>Observer session projections.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {overview.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No projected sessions yet.</p>
          ) : (
            overview.sessions.map((s) => (
              <Link
                key={String(s.id)}
                href={`/observer/sessions/${encodeURIComponent(String(s.sessionId))}`}
              >
                <div className="flex items-center gap-2 rounded border-b py-1 hover:bg-accent/40">
                  <Badge variant="secondary">{String(s.provider)}</Badge>
                  <span className="font-mono text-xs">{String(s.sessionId).slice(0, 24)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatRelative(String(s.lastSeenAt))}
                  </span>
                </div>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
