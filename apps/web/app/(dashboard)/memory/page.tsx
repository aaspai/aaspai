import { Brain, ExternalLink, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { isAaspaiWorkspace, listMemoryRecords, workspaceRoot } from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  if (!isAaspaiWorkspace()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No aaspai workspace</CardTitle>
          <CardDescription>
            The memory explorer reads operational evidence from the current workspace (
            {workspaceRoot()}).
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { q = "" } = await searchParams;
  const records = await listMemoryRecords({ query: q });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Operational memory
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Brain className="h-5 w-5 text-primary" /> Memory explorer
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Evidence-backed recall for the company. Memory is scoped and reviewable; it never
            overrides policy, identity, or canonical definitions.
          </p>
        </div>
        <Badge variant="outline">{records.length} shown</Badge>
      </header>

      <form className="flex max-w-2xl gap-2" method="get">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search observations, decisions, and diaries"
            className="pl-9"
          />
        </div>
        <button
          className="rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          type="submit"
        >
          Search
        </button>
      </form>

      {records.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {q ? "No memory matched that search." : "No operational memory has been captured yet."}
          </CardContent>
        </Card>
      ) : (
        <section className="space-y-4">
          {records.map((record) => {
            const promotionCandidate = ["decision", "solution"].includes(record.kind);
            return (
              <Card key={record.id}>
                <CardHeader className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-base">{record.title}</CardTitle>
                        <Badge variant="secondary">{record.kind}</Badge>
                        <Badge variant="outline">{record.status}</Badge>
                        <Badge variant="outline">{record.sensitivity}</Badge>
                      </div>
                      <CardDescription className="mt-1 font-mono text-[10px]">
                        {record.id}
                      </CardDescription>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelative(record.createdAt)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6">
                    {record.content}
                  </p>
                </CardHeader>
                <CardContent className="space-y-4 text-xs">
                  <div className="grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Meta label="Scope" value={scopeLabel(record.scope)} />
                    <Meta
                      label="Provenance"
                      value={`${record.provenance.sourceType} · ${record.provenance.sourceId}`}
                    />
                    <Meta
                      label="Retention"
                      value={`${record.retention.policy}${record.retention.expiresAt ? ` · until ${record.retention.expiresAt}` : ""}`}
                    />
                    <Meta
                      label="Evidence"
                      value={`${record.evidence.length} linked source${record.evidence.length === 1 ? "" : "s"}`}
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {record.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                    {promotionCandidate && <Badge variant="secondary">review for knowledge</Badge>}
                    {record.supersedesId && (
                      <Badge variant="outline">supersedes {record.supersedesId}</Badge>
                    )}
                  </div>
                  <div className="rounded-md bg-muted/40 p-3">
                    <p className="font-medium text-foreground">Evidence links</p>
                    <ul className="mt-2 space-y-1.5 text-muted-foreground">
                      {record.evidence.map((evidence) => (
                        <li
                          key={`${evidence.kind}:${evidence.sourceId}`}
                          className="flex flex-wrap items-center gap-1.5"
                        >
                          <span>{evidence.label}</span>
                          <span className="font-mono text-[10px]">
                            {evidence.kind}/{evidence.sourceId}
                          </span>
                          {evidence.uri && (
                            <a
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                              href={evidence.uri}
                            >
                              open <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </section>
      )}
    </div>
  );
}

function scopeLabel(scope: {
  organizationId: string;
  projectId: string | null;
  goalId: string | null;
  workItemId: string | null;
  agentId: string | null;
  topic: string | null;
}): string {
  const parts = [
    scope.projectId,
    scope.goalId,
    scope.workItemId,
    scope.agentId,
    scope.topic,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : scope.organizationId;
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 break-words text-foreground">{value}</p>
    </div>
  );
}
