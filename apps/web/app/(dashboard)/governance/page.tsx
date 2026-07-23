import {
  CircleDollarSign,
  ExternalLink,
  FileCheck2,
  GitPullRequest,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getCompanyOverview,
  isAaspaiWorkspace,
  listAutonomyChangeRequests,
  listAutonomyProposals,
} from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function GovernancePage() {
  if (!isAaspaiWorkspace()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No aaspai workspace</CardTitle>
          <CardDescription>Initialize a workspace to inspect governance activity.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const overview = await getCompanyOverview();
  const [changeRequests, proposals] = await Promise.all([
    listAutonomyChangeRequests(overview.organizationId ?? undefined),
    listAutonomyProposals(overview.organizationId ?? undefined),
  ]);
  const approvals = overview.approvals.filter((approval) => approval.status === "requested");
  const verificationItems = overview.workItems.filter((item) => item.verificationRequired);
  const failedRequests = changeRequests.filter((request) => request.status === "failed");

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Company governance
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Decisions and changes</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          One inbox for human approvals, verification waits, and definition changes. This surface is
          read-only: execution and Git publication remain governed operations.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <SummaryCard icon={ShieldCheck} label="Approvals waiting" value={approvals.length} />
        <SummaryCard
          icon={FileCheck2}
          label="Verification-scoped work"
          value={verificationItems.length}
        />
        <SummaryCard
          icon={GitPullRequest}
          label="Failed publications"
          value={failedRequests.length}
        />
        <SummaryCard
          icon={ShieldCheck}
          label="Autonomy proposals"
          value={proposals.filter((proposal) => proposal.status !== "rejected").length}
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Human decisions</CardTitle>
            <CardDescription>
              Work that is paused until an explicit approval is recorded.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {approvals.length === 0 ? (
              <EmptyState text="No work is waiting for approval." />
            ) : (
              approvals.map((approval) => (
                <div key={approval.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {approval.workItemTitle ?? approval.workItemId}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {approval.reason || `Requested by ${approval.actorType}`}
                      </p>
                    </div>
                    <Badge variant="outline">{approval.actorType}</Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>Requested {formatRelative(approval.requestedAt)}</span>
                    {approval.attemptId ? (
                      <Link
                        className="text-primary hover:underline"
                        href={`/execution/attempts/${encodeURIComponent(approval.attemptId)}`}
                      >
                        Open attempt
                      </Link>
                    ) : (
                      <Link className="text-primary hover:underline" href="/execution">
                        Open execution
                      </Link>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Verification boundary</CardTitle>
            <CardDescription>
              Work items that carry an independent checker requirement.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {verificationItems.length === 0 ? (
              <EmptyState text="No verification-scoped work is registered." />
            ) : (
              verificationItems.slice(0, 8).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    {item.attemptId ? (
                      <Link
                        className="truncate text-sm font-medium text-primary hover:underline"
                        href={`/execution/attempts/${encodeURIComponent(item.attemptId)}`}
                      >
                        {item.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm font-medium">{item.title}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.status} · {item.evidenceCount} evidence item(s)
                    </p>
                  </div>
                  <Badge variant={item.status === "completed" ? "default" : "secondary"}>
                    {item.status}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Definition change requests</CardTitle>
          <CardDescription>
            Approved autonomy proposals become isolated commits and pull requests. The source
            definition checkout is never silently modified.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {changeRequests.length === 0 ? (
            <EmptyState text="No Git-backed definition changes have been published." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2">Target</th>
                    <th className="px-2 py-2">Branch</th>
                    <th className="px-2 py-2">Updated</th>
                    <th className="px-2 py-2 text-right">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {changeRequests.map((request) => (
                    <tr key={request.id} className="border-b last:border-0">
                      <td className="px-2 py-3">
                        <Badge variant={request.status === "failed" ? "destructive" : "secondary"}>
                          {request.status}
                        </Badge>
                      </td>
                      <td className="px-2 py-3">
                        <div className="font-medium">{request.targetPath}</div>
                        {request.error && (
                          <div className="mt-1 max-w-sm text-xs text-destructive">
                            {request.error}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-3 font-mono text-xs text-muted-foreground">
                        {request.branchName}
                      </td>
                      <td className="px-2 py-3 text-xs text-muted-foreground">
                        {formatRelative(request.updatedAt)}
                      </td>
                      <td className="px-2 py-3 text-right">
                        {request.pullRequestUrl ? (
                          <a
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                            href={request.pullRequestUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            PR #{request.pullRequestNumber}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">No PR</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleDollarSign className="h-4 w-4 text-emerald-600" /> Budget posture
            </CardTitle>
            <CardDescription>
              Durable reservations and actual usage for this company.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <Metric
              label="Reserved cost"
              value={`$${overview.budget.reservedCostUsd.toFixed(4)}`}
            />
            <Metric label="Actual cost" value={`$${overview.budget.actualCostUsd.toFixed(4)}`} />
            <Metric
              label="Reserved tokens"
              value={overview.budget.reservedTokens.toLocaleString()}
            />
            <Metric label="Actual tokens" value={overview.budget.actualTokens.toLocaleString()} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Autonomy proposals</CardTitle>
            <CardDescription>
              Proposed policy changes remain visible until reviewed and published through Git.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {proposals.length === 0 ? (
              <EmptyState text="No autonomy proposals have been recorded." />
            ) : (
              proposals.slice(0, 8).map((proposal) => {
                const request = changeRequests.find((item) => item.proposalId === proposal.id);
                return (
                  <div key={proposal.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">
                        {proposal.targetType} · {proposal.targetId}
                      </p>
                      <Badge variant={proposal.status === "rejected" ? "destructive" : "secondary"}>
                        {proposal.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {proposal.fromLevel} → {proposal.toLevel} · {proposal.rationale}
                    </p>
                    {request?.pullRequestUrl && (
                      <a
                        className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        href={request.pullRequestUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open definition PR <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof ShieldCheck;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <Icon className="h-5 w-5 text-primary" />
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{text}</p>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
