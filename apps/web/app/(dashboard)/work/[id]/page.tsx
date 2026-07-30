import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCompanyOverview, isAaspaiWorkspace } from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function WorkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isAaspaiWorkspace()) notFound();
  const { id } = await params;
  const overview = await getCompanyOverview();
  const work = overview.workItems.find((item) => item.id === decodeURIComponent(id));
  if (!work) notFound();
  const goal = overview.goals.find((item) => item.id === work.goalId);
  const approvals = overview.approvals.filter((item) => item.workItemId === work.id);
  const evidence = overview.evidence.filter((item) => item.workItemId === work.id);
  const decisions = overview.governance.filter((item) => item.workItemId === work.id);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={goal ? `/goals/${encodeURIComponent(goal.id)}` : "/execution"}>
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> {goal ? "Objective" : "Execution"}
        </Link>
      </Button>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{work.title}</h1>
          <Badge variant={work.status === "failed" ? "destructive" : "secondary"}>
            {work.status.replaceAll("_", " ")}
          </Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{work.description}</p>
      </header>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <main className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Evidence and activity</CardTitle>
              <CardDescription>Durable outputs recorded for this work item.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {evidence.map((item) => (
                <article key={item.id} className="border-b pb-4 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium">{item.title}</h2>
                    <span className="text-xs text-muted-foreground">
                      {formatRelative(item.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                    {item.body}
                  </p>
                </article>
              ))}
              {decisions.map((item) => (
                <article key={item.id} className="border-b pb-4 last:border-0 last:pb-0">
                  <h2 className="text-sm font-medium">{item.action.replaceAll("_", " ")}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{item.reason}</p>
                </article>
              ))}
              {!evidence.length && !decisions.length && (
                <p className="text-sm text-muted-foreground">No evidence has been recorded yet.</p>
              )}
            </CardContent>
          </Card>
        </main>
        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Ownership</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row
                label="Objective"
                value={goal?.title ?? work.goalId}
                href={`/goals/${encodeURIComponent(work.goalId)}`}
              />
              <Row label="Project" value={work.projectTitle ?? work.projectId} />
              <Row
                label="Owner"
                value={work.owner?.replace("agent/", "") ?? "Unassigned"}
                href={work.owner ? `/agents/${work.owner}` : undefined}
              />
              <Row label="Priority" value={String(work.priority)} />
              <Row label="Updated" value={formatRelative(work.updatedAt)} />
            </CardContent>
          </Card>
          {(work.attemptId || approvals.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>Lineage</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {work.attemptId && (
                  <Link
                    href={`/execution/attempts/${encodeURIComponent(work.attemptId)}`}
                    className="flex items-center justify-between text-sm text-primary hover:underline"
                  >
                    Open execution attempt <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                )}
                {approvals.map((approval) => (
                  <Link
                    key={approval.id}
                    href={`/governance/${encodeURIComponent(approval.id)}`}
                    className="flex items-center justify-between text-sm text-primary hover:underline"
                  >
                    Open {approval.status} decision <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
          {work.dependencyIds.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Dependencies</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {work.dependencyIds.map((dependencyId, index) => (
                  <Link
                    key={dependencyId}
                    href={`/work/${encodeURIComponent(dependencyId)}`}
                    className="block text-sm hover:underline"
                  >
                    {work.dependencyTitles[index] ?? dependencyId}
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      {href ? (
        <Link href={href} className="text-right hover:underline">
          {value}
        </Link>
      ) : (
        <span className="text-right">{value}</span>
      )}
    </div>
  );
}
