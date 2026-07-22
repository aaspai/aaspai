import { ArrowLeft, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  getAgent,
  getAgentSystemPrompt,
  isAaspaiWorkspace,
  listRecentSessions,
} from "@/lib/aaspai";
import { formatRelative, truncate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  ceo: "Chief of Staff",
  cto: "CTO",
  cmo: "Marketing",
  cfo: "Finance",
  security: "Security",
  engineer: "Engineer",
  designer: "Designer",
  pm: "PM",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
  operator: "Operator",
  general: "Generalist",
};

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agentId = decodeURIComponent(id);

  if (!isAaspaiWorkspace()) notFound();

  const [agent, systemPrompt, recentSessions] = await Promise.all([
    getAgent(agentId),
    getAgentSystemPrompt(agentId),
    listRecentSessions(20),
  ]);
  if (!agent) notFound();

  const ownSessions = recentSessions.filter((s) => s.agentId === agentId).slice(0, 8);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/agents">
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          All agents
        </Link>
      </Button>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{agent.title}</h1>
            <Badge variant="secondary">{ROLE_LABEL[agent.role] ?? agent.role}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{agent.id}</code>
          </p>
        </div>
        <Button asChild>
          <Link href={`/chat/${encodeURIComponent(agentId)}`}>
            <MessagesSquare className="mr-1.5 h-4 w-4" />
            Chat with {agent.title}
          </Link>
        </Button>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Adapter" value={agent.adapter} />
            <Row label="Model" value={agent.model ?? "—"} mono />
            <Row label="Role" value={ROLE_LABEL[agent.role] ?? agent.role} />
            <Row
              label="Reports to"
              value={agent.reportsTo ?? "—"}
              href={agent.reportsTo ? `/agents/${encodeURIComponent(agent.reportsTo)}` : undefined}
            />
            <Separator />
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Manages
              </p>
              {agent.manages.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No direct reports.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {agent.manages.map((m) => (
                    <li key={m}>
                      <Link
                        href={`/agents/${encodeURIComponent(m)}`}
                        className="text-sm text-foreground/80 hover:text-foreground hover:underline"
                      >
                        {m.replace(/^agent\//, "")}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {agent.peers.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Peers
                </p>
                <ul className="mt-2 space-y-1">
                  {agent.peers.map((p) => (
                    <li key={p}>
                      <Link
                        href={`/agents/${encodeURIComponent(p)}`}
                        className="text-sm text-foreground/80 hover:text-foreground hover:underline"
                      >
                        {p.replace(/^agent\//, "")}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>System prompt</CardTitle>
            <CardDescription>
              What this agent is told when it wakes up. Edit{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                {agent.id.replace(/^agent\//, "agents/")}/AGENT.md
              </code>{" "}
              to change.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {systemPrompt ? (
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
                {truncate(systemPrompt, 4000)}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                No system prompt defined. Add a body to{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">AGENT.md</code>.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            The {ownSessions.length} most recent sessions for {agent.title}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ownSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sessions yet for this agent.{" "}
              <Link
                href={`/chat/${encodeURIComponent(agentId)}`}
                className="text-foreground hover:underline"
              >
                Start one →
              </Link>
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {ownSessions.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-md border bg-background/50 px-3 py-2"
                >
                  <div className="min-w-0">
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
                    <span className="ml-2 text-xs text-muted-foreground">via {s.adapter}</span>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <div>{formatRelative(s.startedAt)}</div>
                    {s.durationMs != null && <div className="tabular-nums">{s.durationMs}ms</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  href,
}: {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {href ? (
        <Link href={href} className="text-sm text-foreground hover:underline">
          {value}
        </Link>
      ) : (
        <span className={mono ? "font-mono text-sm" : "text-sm"}>{value}</span>
      )}
    </div>
  );
}
