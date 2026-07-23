import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock3,
  GitPullRequest,
  ShieldAlert,
} from "lucide-react";
import { KnowledgeReview } from "@/components/knowledge-review";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getKnowledgeSnapshot, isAaspaiWorkspace, workspaceRoot } from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  if (!isAaspaiWorkspace()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No aaspai workspace</CardTitle>
          <CardDescription>
            Knowledge proposals are stored against the current workspace ({workspaceRoot()}).
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const snapshot = await getKnowledgeSnapshot();
  const pending = snapshot.proposals.filter((proposal) =>
    ["proposed", "under_review"].includes(proposal.status),
  );
  const accepted = snapshot.proposals.filter((proposal) => proposal.status === "accepted");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Curated knowledge
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BookOpen className="h-5 w-5 text-primary" /> Knowledge review
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Review evidence-backed proposals before they become Blueprint change requests. Accepted
            knowledge never bypasses Git review.
          </p>
        </div>
        <Badge variant="outline">{snapshot.organizationId ?? "no company"}</Badge>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Pending proposals" value={pending.length} icon={Clock3} />
        <Metric label="Accepted proposals" value={accepted.length} icon={CheckCircle2} />
        <Metric label="Temporal facts" value={snapshot.facts.length} icon={BookOpen} />
        <Metric label="Signals" value={snapshot.signals.length} icon={ShieldAlert} />
      </section>

      {snapshot.signals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" /> Contradictions and staleness
            </CardTitle>
            <CardDescription>
              Signals are review prompts, not silent fact mutations.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {snapshot.signals.map((signal) => (
              <div
                key={`${signal.kind}:${signal.factIds.join("-")}:${signal.title}`}
                className="rounded-md border p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={signal.severity === "critical" ? "destructive" : "outline"}>
                    {signal.severity}
                  </Badge>
                  <span className="font-medium">{signal.title}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{signal.detail}</p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  facts: {signal.factIds.join(", ")}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <section className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardHeader>
            <CardTitle>Proposal queue</CardTitle>
            <CardDescription>
              Every proposal keeps its source memories, facts, target path, and impact summary.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {snapshot.proposals.length === 0 ? (
              <p className="text-sm text-muted-foreground">No knowledge proposals yet.</p>
            ) : (
              snapshot.proposals.map((proposal) => (
                <div key={proposal.id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{proposal.title}</span>
                        <Badge variant="secondary">{proposal.status}</Badge>
                        <Badge variant="outline">{proposal.knowledgeType}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{proposal.summary}</p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatRelative(proposal.createdAt)}
                    </span>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{proposal.content}</p>
                  <div className="mt-3 grid gap-2 border-t pt-3 text-xs sm:grid-cols-2">
                    <Meta label="Target" value={proposal.targetPath} />
                    <Meta label="Impact" value={proposal.impactSummary} />
                    <Meta label="Memory evidence" value={proposal.sourceMemoryIds.join(", ")} />
                    <Meta
                      label="Facts"
                      value={proposal.factIds.length ? proposal.factIds.join(", ") : "none"}
                    />
                  </div>
                  {["proposed", "under_review"].includes(proposal.status) &&
                    snapshot.organizationId && (
                      <div className="mt-4">
                        <KnowledgeReview
                          organizationId={snapshot.organizationId}
                          proposalId={proposal.id}
                        />
                      </div>
                    )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GitPullRequest className="h-4 w-4 text-primary" /> Blueprint change requests
              </CardTitle>
              <CardDescription>
                Proposed edits await the Git-backed definition workflow.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {snapshot.changeRequests.length === 0 ? (
                <p className="text-sm text-muted-foreground">No change requests yet.</p>
              ) : (
                snapshot.changeRequests.map((request) => (
                  <div key={request.id} className="rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{request.targetPath}</span>
                      <Badge variant="outline">{request.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{request.impactSummary}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Temporal facts</CardTitle>
              <CardDescription>
                Facts keep validity windows and history separate from reviewed files.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {snapshot.facts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No facts yet.</p>
              ) : (
                snapshot.facts.slice(0, 12).map((fact) => (
                  <div key={fact.id} className="rounded-md border p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{fact.status}</Badge>
                      <span className="font-medium">
                        {fact.subject} · {fact.predicate}
                      </span>
                    </div>
                    <p className="mt-1">{JSON.stringify(fact.value)}</p>
                    <p className="mt-1 text-muted-foreground">
                      confidence {Math.round(fact.confidence * 100)}% · verified{" "}
                      {fact.lastVerifiedAt ? formatRelative(fact.lastVerifiedAt) : "never"}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof BookOpen;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 break-words text-foreground">{value}</p>
    </div>
  );
}
