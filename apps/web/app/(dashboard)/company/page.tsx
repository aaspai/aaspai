import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock3,
  ExternalLink,
  FileText,
  UserRoundPlus,
} from "lucide-react";
import Link from "next/link";
import { DecisionActions, GiveDirection } from "@/components/company-actions";
import { CompanyControlActions } from "@/components/company-control-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getCompanyOverview,
  getLatestAgentBriefing,
  getStrategicSummary,
  isAaspaiWorkspace,
} from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";
import { formatRelative } from "@/lib/utils";
import { readFrontendOnboarding } from "@/lib/workspace-bootstrap";

export const dynamic = "force-dynamic";

export default async function CompanyPage() {
  if (!isAaspaiWorkspace()) return <p>No company workspace is configured.</p>;
  const [overview, user, onboarding, briefing, strategic] = await Promise.all([
    getCompanyOverview(),
    currentUser(),
    readFrontendOnboarding(),
    getLatestAgentBriefing("agent/ceo"),
    getStrategicSummary(),
  ]);
  const goal = overview.goals[0];
  const work = overview.workItems.filter((item) => item.goalId === goal?.id);
  const pending = overview.approvals.filter((approval) => approval.status === "requested");
  const latestAttempt = overview.attempts[0];
  const latestEvidence = overview.evidence[0];
  const lifecycleStatus = strategic?.profile?.lifecycleStatus ?? "draft";
  const discovery = overview.discovery;
  const today = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">{user?.companyName}</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{onboarding?.ceoAgenda}</p>
        </div>
        <div className="flex items-center gap-3">
          <p className="hidden text-sm text-muted-foreground sm:block">{today}</p>
          {strategic?.profile && (
            <CompanyControlActions lifecycleStatus={strategic.profile.lifecycleStatus} />
          )}
        </div>
      </header>

      {lifecycleStatus === "discovery" && (
        <section className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">
              {discovery.status === "failed"
                ? "CEO discovery failed"
                : discovery.status === "queued"
                  ? "CEO discovery queued"
                  : "CEO discovery is running"}
            </h2>
            <Badge variant={discovery.status === "failed" ? "destructive" : "secondary"}>
              {discovery.status}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            The CEO is studying the mandate and will return an evidence-backed project portfolio for
            your review.
          </p>
          {discovery.error ? (
            <p className="mt-3 whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {discovery.error}
            </p>
          ) : null}
          {discovery.attemptId ? (
            <Button asChild variant="outline" size="sm" className="mt-4">
              <Link href={`/execution/attempts/${encodeURIComponent(discovery.attemptId)}`}>
                Open execution detail <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          ) : null}
        </section>
      )}

      {lifecycleStatus === "review" && (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-base font-semibold">CEO discovery review</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {overview.portfolioProposal?.summary ??
              "The CEO completed discovery. Review the proposed portfolio, then approve activation."}
          </p>
          <div className="mt-4 space-y-3">
            {overview.portfolioProposal?.projects.map((project) => (
              <div key={`${project.goalId}:${project.title}`} className="rounded-md border p-3">
                <p className="text-sm font-medium">{project.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{project.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border bg-card p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <CheckCircle2 className="mt-0.5 h-7 w-7 shrink-0" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">
                  {lifecycleStatus === "active"
                    ? "The company is running."
                    : lifecycleStatus === "review"
                      ? "Company plan ready for review."
                      : lifecycleStatus === "discovery"
                        ? discovery.status === "failed"
                          ? "CEO discovery needs attention."
                          : "The CEO is preparing the company plan."
                        : "Company setup is in progress."}
                </h2>
                <Badge variant="secondary">{lifecycleStatus}</Badge>
              </div>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                {onboarding?.ceoAgenda ?? "The CEO is operating from the founder mandate."}
              </p>
            </div>
          </div>
          <div className="grid min-w-0 flex-[1.1] gap-4 border-t pt-4 sm:grid-cols-2 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
            <Summary
              label="Current objective"
              value={goal?.title ?? "Waiting for direction"}
              href={goal ? `/goals/${encodeURIComponent(goal.id)}` : undefined}
            />
            <Summary
              label="Last CEO heartbeat"
              value={latestAttempt ? formatRelative(latestAttempt.createdAt) : "Not run yet"}
            />
          </div>
          <GiveDirection currentObjective={goal?.title} />
        </div>
      </section>

      <div className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_440px]">
        <main className="min-w-0 space-y-8">
          <section>
            <h2 className="text-xl font-semibold">CEO briefing</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Strategic update from your CEO
              {latestAttempt ? ` · ${formatRelative(latestAttempt.createdAt)}` : ""}
            </p>
            <p className="mt-5 max-w-3xl whitespace-pre-wrap text-base leading-7">
              {latestEvidence?.body ??
                briefing ??
                (latestAttempt
                  ? `The CEO's latest run is ${latestAttempt.status}. Evidence and requested decisions will appear here as they are recorded.`
                  : "The first CEO mandate is queued. The briefing will appear after the first heartbeat.")}
            </p>
          </section>

          <section className="border-t pt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Live operating plan</h2>
              <Link
                href="/execution"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                View all work
              </Link>
            </div>
            <div className="mt-4 divide-y border-y">
              {work.length ? (
                work.slice(0, 6).map((item, index) => (
                  <Link
                    key={item.id}
                    href={`/work/${encodeURIComponent(item.id)}`}
                    className="grid gap-3 py-4 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[28px_minmax(0,1fr)_110px_130px] sm:items-center"
                  >
                    <span className="text-sm font-medium">{index + 1}</span>
                    <div>
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                    <Badge variant="outline" className="w-fit">
                      {(item.owner ?? "agent/ceo").replace("agent/", "")}
                    </Badge>
                    <WorkStatus status={item.status} />
                  </Link>
                ))
              ) : (
                <p className="py-8 text-sm text-muted-foreground">No operating plan yet.</p>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-base font-semibold">Recent activity</h2>
            <div className="mt-3 space-y-1">
              {overview.evidence.slice(0, 4).map((item) => (
                <ActivityRow
                  key={item.id}
                  title={item.title}
                  detail={item.body}
                  at={item.createdAt}
                  href={
                    item.workItemId ? `/work/${encodeURIComponent(item.workItemId)}` : undefined
                  }
                />
              ))}
              {overview.governance.slice(0, 4).map((item) => (
                <ActivityRow
                  key={item.id}
                  title={item.action.replaceAll("_", " ")}
                  detail={item.reason}
                  at={item.occurredAt}
                  href={
                    item.workItemId ? `/work/${encodeURIComponent(item.workItemId)}` : undefined
                  }
                />
              ))}
              {!overview.evidence.length && !overview.governance.length && (
                <ActivityRow
                  title="Company launched"
                  detail={`${user?.companyName} is live with the CEO as its only employee.`}
                  at={onboarding?.completedAt ?? new Date().toISOString()}
                />
              )}
            </div>
          </section>
        </main>

        <aside className="space-y-7 border-t pt-7 xl:border-l xl:border-t-0 xl:pl-7 xl:pt-0">
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Needs you</h2>
              <Badge variant="secondary">{pending.length} decisions</Badge>
            </div>
            <div className="mt-4 space-y-3">
              {pending.length ? (
                pending.map((approval) => (
                  <div key={approval.id} className="rounded-lg border bg-card p-4">
                    <div className="flex items-start gap-3">
                      <ExternalLink className="mt-0.5 h-5 w-5" />
                      <div>
                        <Link
                          href={`/governance/${encodeURIComponent(approval.id)}`}
                          className="font-semibold hover:underline"
                        >
                          {approval.workItemTitle ?? "Founder decision"}
                        </Link>
                        <Badge variant="secondary" className="mt-2">
                          {approval.actorType} approval
                        </Badge>
                      </div>
                    </div>
                    <p className="my-4 text-sm leading-6 text-muted-foreground">
                      {approval.reason || "The CEO needs your approval before continuing."}
                    </p>
                    <DecisionActions approvalId={approval.id} />
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                  No decisions are waiting. The CEO will pause here when founder authority is
                  required.
                </div>
              )}
            </div>
            <Button variant="ghost" className="mt-2 w-full justify-between" asChild>
              <Link href="/governance">
                View all decisions <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </section>

          <section className="border-t pt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Team</h2>
              <Link href="/agents" className="text-xs text-muted-foreground hover:text-foreground">
                View team
              </Link>
            </div>
            <div className="mt-4 space-y-3">
              {overview.agents.map((agent) => (
                <Link
                  key={agent.id}
                  href={`/agents/${agent.id}`}
                  className="flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    {agent.role.toUpperCase().slice(0, 3)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{agent.title}</p>
                    <p className="text-xs text-muted-foreground">{agent.role}</p>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-emerald-700">
                    <Circle className="h-2 w-2 fill-current" /> Active
                  </span>
                </Link>
              ))}
              {overview.agents.length === 1 && (
                <div className="flex items-start gap-3 border-t pt-3 text-xs text-muted-foreground">
                  <UserRoundPlus className="h-4 w-4 shrink-0" />
                  No hires are proposed. Staffing changes require a founder decision.
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Summary({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      {href ? (
        <Link href={href} className="mt-1 block text-sm font-semibold hover:underline">
          {value}
        </Link>
      ) : (
        <p className="mt-1 text-sm font-semibold">{value}</p>
      )}
    </div>
  );
}

function WorkStatus({ status }: { status: string }) {
  return (
    <span className="flex items-center gap-2 text-xs">
      {status === "completed" ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
      ) : status === "ready" ? (
        <Clock3 className="h-3.5 w-3.5 text-blue-600" />
      ) : (
        <Circle className="h-3.5 w-3.5 fill-blue-500 text-blue-500" />
      )}
      {status.replaceAll("_", " ")}
    </span>
  );
}

function ActivityRow({
  title,
  detail,
  at,
  href,
}: {
  title: string;
  detail: string;
  at: string;
  href?: string;
}) {
  const content = (
    <div className="grid grid-cols-[36px_minmax(0,1fr)_auto] gap-3 py-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-full border">
        <FileText className="h-4 w-4" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detail}</p>
      </div>
      <span className="text-[11px] text-muted-foreground">{formatRelative(at)}</span>
    </div>
  );
  return href ? (
    <Link
      href={href}
      className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {content}
    </Link>
  ) : (
    content
  );
}
