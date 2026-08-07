import { Boxes } from "lucide-react";
import Link from "next/link";
import { SessionLiveRefresh } from "@/components/session-live-refresh";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAaspaiWorkspace, listRecentSessions } from "@/lib/aaspai";
import { listLiveSandboxes } from "@/lib/sandboxes";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SANDBOX_STATUS_VARIANT: Record<string, "default" | "destructive" | "secondary" | "outline"> =
  {
    alive: "default",
    ready: "default",
    hibernating: "secondary",
    archived: "secondary",
    provisioning: "secondary",
    failed: "destructive",
    deleted: "outline",
  };

function SandboxStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={SANDBOX_STATUS_VARIANT[status] ?? "secondary"}>
      <span
        className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
          status === "alive" || status === "ready"
            ? "bg-emerald-500"
            : status === "hibernating" || status === "archived"
              ? "bg-amber-500"
              : "bg-muted-foreground/50"
        }`}
      />
      {status}
    </Badge>
  );
}

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
  const live = await listLiveSandboxes();
  return (
    <div className="space-y-6">
      <SessionLiveRefresh />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-sm text-muted-foreground">{sessions.length} most recent agent runs.</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Boxes className="h-4 w-4" />
            Live sandboxes
            <Badge variant="secondary">{live.length}</Badge>
          </CardTitle>
          <CardDescription>
            Cloud sandboxes currently provisioned for sessions. Each session owns its sandbox;
            leases are kept alive for reuse and archived after inactivity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {live.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No live sandboxes right now. Sandboxes are provisioned when a session runs on a cloud
              runtime (e.g. Daytona).
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2">Agent</th>
                    <th className="px-2 py-2">Adapter</th>
                    <th className="px-2 py-2">Provider</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2">Session</th>
                    <th className="px-2 py-2">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((sbx) => (
                    <tr key={sbx.id} className="border-b last:border-0">
                      <td className="px-2 py-2">
                        <Link href={`/agents/${sbx.agentId}`} className="hover:underline">
                          {sbx.agentId.replace(/^agent\//, "")}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">{sbx.adapter}</td>
                      <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                        {sbx.provider}
                      </td>
                      <td className="px-2 py-2">
                        <SandboxStatusBadge status={sbx.status} />
                      </td>
                      <td className="px-2 py-2">
                        {sbx.sessionId ? (
                          <Link
                            href={`/sessions/${encodeURIComponent(sbx.sessionId)}`}
                            className="font-mono text-xs hover:underline"
                          >
                            {sbx.sessionId.slice(0, 16)}…
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {sbx.lastActiveAt ? formatRelative(sbx.lastActiveAt) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
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
                      className="group cursor-pointer border-b last:border-0 transition-colors hover:bg-accent/40"
                    >
                      <td className="px-2 py-2">
                        <Link href={`/sessions/${encodeURIComponent(s.id)}`} className="block">
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
                        </Link>
                      </td>
                      <td className="px-2 py-2">
                        <Link
                          href={`/sessions/${encodeURIComponent(s.id)}`}
                          className="block hover:underline"
                        >
                          {s.agentId.replace(/^agent\//, "")}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        <Link href={`/sessions/${encodeURIComponent(s.id)}`} className="block">
                          {s.adapter}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        <Link href={`/sessions/${encodeURIComponent(s.id)}`} className="block">
                          {formatRelative(s.startedAt)}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">
                        <Link href={`/sessions/${encodeURIComponent(s.id)}`} className="block">
                          {s.durationMs != null ? `${s.durationMs}ms` : "—"}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-[10px] text-muted-foreground/70">
                        <Link
                          href={`/sessions/${encodeURIComponent(s.id)}`}
                          className="block group-hover:text-foreground"
                        >
                          {s.id.slice(0, 16)}…
                        </Link>
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
