import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getObserverDashboards, getObserverDefaultDashboard } from "@/lib/observer";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ObserverDashboardsPage() {
  const dashboards = getObserverDashboards();
  const defaultDashboard = getObserverDefaultDashboard();

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboards</h1>
          <p className="text-sm text-muted-foreground">
            Dashboard widgets are data definitions (query + layout), not rendered blobs.
          </p>
        </div>
        <Link href="/observer" className="text-xs text-primary hover:underline">
          ← Overview
        </Link>
      </header>

      {defaultDashboard && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{String(defaultDashboard.name)}</CardTitle>
            <CardDescription>
              Default dashboard with{" "}
              {Array.isArray(defaultDashboard.widgets) ? defaultDashboard.widgets.length : 0}{" "}
              widget(s).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {(Array.isArray(defaultDashboard.widgets) ? defaultDashboard.widgets : []).map(
              (widget) => (
                <div key={String(widget.id)} className="rounded border p-3">
                  <div className="text-sm font-medium">{String(widget.title)}</div>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {String(widget.widgetType)}
                    <br />
                    {widget.config ? JSON.stringify(widget.config).slice(0, 160) : ""}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    col {Number(widget.gridColumn)} row {Number(widget.gridRow)} ·{" "}
                    {Number(widget.colSpan)}x{Number(widget.rowSpan)}
                  </div>
                </div>
              ),
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All dashboards ({dashboards.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {dashboards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No dashboards yet. Create one via the API (<code>POST /v1/telemetry/dashboards</code>
              ).
            </p>
          ) : (
            <div className="space-y-1">
              {dashboards.map((d) => (
                <div key={String(d.id)} className="flex items-center gap-2 text-sm">
                  <Badge variant={d.isDefault ? "default" : "outline"}>
                    {d.isDefault ? "default" : "dashboard"}
                  </Badge>
                  <span>{String(d.name)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatRelative(String(d.createdAt))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
