import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  FileCheck2,
  GitBranch,
  Goal,
  HeartPulse,
  Layers3,
  ShieldAlert,
  Timer,
} from "lucide-react";
import Link from "next/link";
import { GoalBuilder } from "@/components/goal-builder";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCompanyOverview, isAaspaiWorkspace } from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function CompanyCommandCenterPage() {
  if (!isAaspaiWorkspace()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No aaspai workspace</CardTitle>
          <CardDescription>
            Initialize a workspace to open the company command center.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const overview = await getCompanyOverview();
  const primaryGoal = overview.goals[0];
  const activeItems = overview.workItems.filter((item) =>
    ["ready", "claimed", "in_progress"].includes(item.status),
  );
  const pendingApprovals = overview.approvals.filter((approval) => approval.status === "requested");
  const latestFailures = overview.attempts
    .filter((attempt) => attempt.status === "failed")
    .slice(0, 4);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Company command center
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Make the company legible</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Goals are the north star. Work, agents, approvals, and evidence are the operating
            picture.
          </p>
        </div>
        <div className="rounded-md border bg-card px-3 py-2 text-right text-xs text-muted-foreground">
          <div className="font-medium text-foreground">
            {overview.organizationId ?? "local company"}
          </div>
          <div className="mt-0.5 truncate max-w-[260px]">{overview.workspace}</div>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Create a goal pipeline</CardTitle>
          <CardDescription>
            Define the outcome and the ordered work your agents will execute.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GoalBuilder />
        </CardContent>
      </Card>

      {overview.health && (
        <section className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex items-center gap-3">
            <HeartPulse className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Company health
              </p>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-2xl font-semibold tabular-nums">{overview.health.score}</span>
                <StatusBadge status={overview.health.status} />
              </div>
            </div>
          </div>
          <MiniStat label="Work completion" value={`${overview.health.completionPercent}%`} />
          <MiniStat
            label="Execution reliability"
            value={`${overview.health.reliabilityPercent}%`}
          />
          <MiniStat
            label="Signals"
            value={`${overview.health.signals.length} · ${overview.health.pendingApprovals + overview.health.pendingVerifications} governance`}
          />
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Active work"
          value={overview.stats.activeWork}
          detail={`${overview.stats.blockedWork} blocked`}
          icon={Activity}
          tone="blue"
        />
        <MetricCard
          title="Pending approval"
          value={overview.stats.pendingApprovals}
          detail="human decisions"
          icon={ShieldAlert}
          tone="amber"
        />
        <MetricCard
          title="Agent attempts"
          value={overview.stats.totalAttempts}
          detail={`${overview.stats.failedAttempts} failed`}
          icon={Bot}
          tone="violet"
        />
        <MetricCard
          title="Evidence"
          value={overview.stats.totalEvidence}
          detail={`${overview.revisions.length} definition revisions`}
          icon={FileCheck2}
          tone="emerald"
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Goal className="h-4 w-4 text-primary" /> Company goals
              </CardTitle>
              <CardDescription>
                Progress is calculated from completed work, not optimism.
              </CardDescription>
            </div>
            <Badge variant="outline">{overview.goals.length} tracked</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {overview.goals.length === 0 ? (
              <EmptyState text="No goals have been registered yet. Goals become the parent of every project and work item." />
            ) : (
              overview.goals.map((goal) => (
                <div key={goal.id} className="rounded-lg border bg-background/50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{goal.title}</span>
                        <StatusBadge status={goal.status} />
                      </div>
                      {goal.description && (
                        <p className="mt-1 text-xs text-muted-foreground">{goal.description}</p>
                      )}
                    </div>
                    <span className="text-sm font-semibold tabular-nums">{goal.percent}%</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${goal.percent}%` }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {goal.completed}/{goal.total} complete
                    </span>
                    <span>{goal.active} active</span>
                    <span>{goal.ready} ready</span>
                    <span>{goal.blocked} blocked</span>
                    <span>{goal.waiting} waiting</span>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600" /> Needs a decision
            </CardTitle>
            <CardDescription>
              Governance pauses that should be visible to the company owner.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingApprovals.length === 0 ? (
              <EmptyState text="Nothing is waiting for approval." />
            ) : (
              pendingApprovals.slice(0, 5).map((approval) => (
                <div
                  key={approval.id}
                  className="rounded-md border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/20"
                >
                  <div className="flex items-start justify-between gap-2">
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
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Requested {formatRelative(approval.requestedAt)}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.4fr_0.6fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Layers3 className="h-4 w-4 text-primary" /> Work queue
              </CardTitle>
              <CardDescription>
                Priority, ownership, dependency, and governance in one view.
              </CardDescription>
            </div>
            <Link
              href="/execution"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Full execution <ArrowRight className="h-3 w-3" />
            </Link>
          </CardHeader>
          <CardContent>
            {activeItems.length === 0 ? (
              <EmptyState text="The queue is clear. Proposed and completed work still appears in Execution." />
            ) : (
              <div className="space-y-2">
                {activeItems.slice(0, 10).map((item) => (
                  <div key={item.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.title}</span>
                          <StatusBadge status={item.status} />
                          {item.priority > 0 && <Badge variant="secondary">P{item.priority}</Badge>}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.projectTitle ?? "Unassigned project"} ·{" "}
                          {item.repositoryTitle ?? "No repository"}
                        </p>
                      </div>
                      {item.owner ? (
                        <Badge variant="outline">{item.owner.replace(/^agent\//, "")}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">unclaimed</span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      {item.branchName && (
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="h-3 w-3" />
                          {item.branchName}
                        </span>
                      )}
                      {item.dependencyIds.length > 0 && (
                        <span>
                          {item.dependencyIds.length} dependency
                          {item.dependencyIds.length === 1 ? "" : "ies"}
                        </span>
                      )}
                      {item.blockedReason && (
                        <span className="text-amber-700 dark:text-amber-400">
                          Blocked: {item.blockedReason}
                        </span>
                      )}
                      {item.approvalRequired && <span>approval required</span>}
                      {item.verificationRequired && (
                        <span>{item.evidenceCount} evidence items</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleDollarSign className="h-4 w-4 text-emerald-600" /> Cost & reliability
            </CardTitle>
            <CardDescription>Operational signals from reservations and attempts.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <MiniStat
                label="Actual cost"
                value={`$${overview.budget.actualCostUsd.toFixed(4)}`}
              />
              <MiniStat
                label="Reserved cost"
                value={`$${overview.budget.reservedCostUsd.toFixed(4)}`}
              />
              <MiniStat
                label="Actual tokens"
                value={overview.budget.actualTokens.toLocaleString()}
              />
              <MiniStat label="Running" value={overview.stats.runningAttempts} />
            </div>
            <div className="border-t pt-3">
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" /> Recent failures
              </p>
              {latestFailures.length === 0 ? (
                <p className="text-sm text-muted-foreground">No failed attempts recorded.</p>
              ) : (
                latestFailures.map((attempt) => (
                  <Link
                    key={attempt.id}
                    href={`/execution/attempts/${encodeURIComponent(attempt.id)}`}
                    className="flex items-center justify-between gap-2 border-b py-2 text-xs last:border-0 hover:bg-accent/40"
                  >
                    <span className="truncate">{attempt.agentId.replace(/^agent\//, "")}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatRelative(attempt.createdAt)}
                    </span>
                  </Link>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4" /> Teams & agents
            </CardTitle>
            <CardDescription>Compiled workforce definitions.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.agents.slice(0, 8).map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="truncate">{agent.title}</span>
                <span className="text-xs text-muted-foreground">{agent.role}</span>
              </div>
            ))}
            {overview.agents.length === 0 && <EmptyState text="No agents loaded." />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <GitBranch className="h-4 w-4" /> Projects & definitions
            </CardTitle>
            <CardDescription>Where the company’s work lives.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.projects.slice(0, 6).map((project) => (
              <div key={project.id} className="rounded-md border px-3 py-2">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{project.title}</span>
                  <Badge variant="secondary">{project.repositoryCount} repos</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{project.status}</p>
              </div>
            ))}
            {overview.projects.length === 0 && <EmptyState text="No projects registered." />}
            {overview.revisions.length > 0 && (
              <div className="border-t pt-2">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Latest blueprint revisions
                </p>
                {overview.revisions.slice(0, 3).map((revision) => (
                  <div
                    key={revision.id}
                    className="flex items-center justify-between gap-2 py-1 text-xs"
                  >
                    <span className="truncate">{revision.sourcePath}</span>
                    <code className="shrink-0 text-[10px] text-muted-foreground">
                      {revision.commitSha.slice(0, 8)}
                      {revision.dirty ? " · dirty" : ""}
                    </code>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Timer className="h-4 w-4" /> Latest activity
            </CardTitle>
            <CardDescription>Runs and evidence retain the why.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.attempts.slice(0, 6).map((attempt) => (
              <Link
                key={attempt.id}
                href={`/execution/attempts/${encodeURIComponent(attempt.id)}`}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs hover:bg-accent/40"
              >
                <span className="truncate">{attempt.agentId.replace(/^agent\//, "")}</span>
                <StatusBadge status={attempt.status} />
              </Link>
            ))}
            {overview.runs.slice(0, 4).map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
              >
                <span className="truncate">
                  {run.sourceType ?? "workflow"} · {run.attemptCount} attempts
                </span>
                <StatusBadge status={run.status} />
              </div>
            ))}
            {overview.attempts.length === 0 && overview.runs.length === 0 && (
              <EmptyState text="No attempts recorded." />
            )}
          </CardContent>
        </Card>
      </section>

      {primaryGoal && overview.evidence.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Evidence from the company
            </CardTitle>
            <CardDescription>
              Loop outputs and verification evidence connected to durable work.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {overview.evidence.slice(0, 6).map((evidence) => (
              <div key={evidence.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{evidence.title}</span>
                  <Badge variant="outline">{evidence.kind}</Badge>
                </div>
                <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{evidence.body}</p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {formatRelative(evidence.createdAt)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  title: string;
  value: number;
  detail: string;
  icon: typeof Activity;
  tone: "blue" | "amber" | "violet" | "emerald";
}) {
  const toneClass = {
    blue: "text-blue-600",
    amber: "text-amber-600",
    violet: "text-violet-600",
    emerald: "text-emerald-600",
  }[tone];
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <Icon className={`h-5 w-5 ${toneClass}`} />
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border bg-background/50 p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "failed" || status === "blocked"
      ? "destructive"
      : status === "succeeded" || status === "completed" || status === "passed"
        ? "default"
        : status === "running" || status === "in_progress"
          ? "secondary"
          : "outline";
  return <Badge variant={variant}>{status.replaceAll("_", " ")}</Badge>;
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
      {text}
    </p>
  );
}
