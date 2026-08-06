import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getObserverSessionDetail } from "@/lib/observer";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ROLE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  user: "default",
  assistant: "secondary",
  tool_use: "outline",
  tool_result: "outline",
  system: "secondary",
  unknown: "outline",
};

export default async function ObserverSessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const detail = getObserverSessionDetail(sessionId);

  if (!detail) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Session not found</CardTitle>
          <CardDescription>No observer projection for {sessionId}.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const summary = detail.summary as Record<string, unknown>;
  const messages = (detail.messages ?? []) as Array<Record<string, unknown>>;
  const logs = (detail.logs ?? []) as Array<Record<string, unknown>>;
  const spans = (detail.spans ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Session</h1>
          <p className="font-mono text-xs text-muted-foreground">{sessionId}</p>
        </div>
        <Link href="/observer/sessions" className="text-xs text-primary hover:underline">
          ← Sessions
        </Link>
      </header>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Provider</CardDescription>
            <CardTitle className="text-base">{String(summary.provider ?? "—")}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Model</CardDescription>
            <CardTitle className="text-base truncate">{String(summary.model ?? "—")}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Messages</CardDescription>
            <CardTitle className="text-base tabular-nums">
              {Number(summary.messageCount ?? 0)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Cost</CardDescription>
            <CardTitle className="text-base tabular-nums">
              {summary.costUsd != null ? `$${Number(summary.costUsd).toFixed(4)}` : "—"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transcript ({messages.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transcript messages projected.</p>
          ) : (
            messages.map((m) => (
              <div key={String(m.id)} className="flex gap-2 text-sm">
                <Badge variant={ROLE_VARIANT[String(m.role)] ?? "outline"}>{String(m.role)}</Badge>
                <div className="min-w-0">
                  <div className="whitespace-pre-wrap break-words text-muted-foreground">
                    {String(m.text ?? "") || (m.toolName ? `Tool call: ${String(m.toolName)}` : "")}
                  </div>
                  {m.toolName ? (
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {String(m.toolName)}
                      {m.toolInput ? ` ${JSON.stringify(m.toolInput).slice(0, 200)}` : ""}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Correlated logs ({logs.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {logs.length === 0 ? (
              <p className="text-muted-foreground">None.</p>
            ) : (
              logs.map((log) => (
                <div key={String(log.id)} className="truncate text-muted-foreground">
                  <span className="text-muted-foreground/60">
                    {formatRelative(String(log.observedAt))}
                  </span>{" "}
                  {String(log.body ?? "")}
                </div>
              ))
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Correlated spans ({spans.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {spans.length === 0 ? (
              <p className="text-muted-foreground">None.</p>
            ) : (
              spans.map((span) => (
                <div key={String(span.id)} className="flex items-center gap-2">
                  <Badge variant="outline">{String(span.status ?? "unset")}</Badge>
                  <span className="truncate">{String(span.name ?? "")}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
