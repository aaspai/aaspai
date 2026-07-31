import { ArrowUpRight, CircleDot, Target } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCompanyOverview, getStrategicSummary, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function GoalsPage() {
  if (!isAaspaiWorkspace())
    return (
      <Card>
        <CardHeader>
          <CardTitle>Goals</CardTitle>
          <CardDescription>Initialize a workspace to manage company objectives.</CardDescription>
        </CardHeader>
      </Card>
    );
  const overview = await getCompanyOverview();
  const strategic = await getStrategicSummary();
  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5" />
          <h1 className="text-3xl font-semibold tracking-tight">Goals</h1>
          <Badge variant="secondary">{overview.goals.length} objectives</Badge>
        </div>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Turn company direction into measurable outcomes, projects, and executable issues.
        </p>
      </header>
      <div className="grid gap-4">
        {overview.goals.map((goal) => {
          const projects = overview.projects.filter((project) => project.goalId === goal.id);
          return (
            <Link key={goal.id} href={`/goals/${encodeURIComponent(goal.id)}`} className="group">
              <Card className="transition-colors group-hover:border-foreground/30">
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle>{goal.title}</CardTitle>
                      <CardDescription className="mt-1 max-w-3xl">
                        {goal.description}
                      </CardDescription>
                    </div>
                    <Badge variant={goal.status === "completed" ? "default" : "secondary"}>
                      {goal.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4 sm:grid-cols-4">
                    <Metric label="Progress" value={`${goal.percent}%`} />
                    <Metric label="Projects" value={String(projects.length)} />
                    <Metric label="Active issues" value={String(goal.active)} />
                    <Metric label="Blocked" value={String(goal.blocked)} />
                  </div>
                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${goal.percent}%` }}
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {goal.completed} of {goal.total} issues complete
                    </span>
                    <span className="inline-flex items-center gap-1 group-hover:text-foreground">
                      Open goal <ArrowUpRight className="h-3 w-3" />
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
      {strategic && strategic.objectives.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Measurement coverage</CardTitle>
            <CardDescription>
              Objective progress is backed by linked projects and observations.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            {strategic.objectives.map((objective) => (
              <div key={objective.id} className="rounded-lg border p-3">
                <p className="font-medium">{objective.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {objective.projectCount} projects · {objective.measurementCount} measurements
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {overview.goals.length === 0 && (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            <CircleDot className="mx-auto mb-3 h-6 w-6" />
            No goals have been created yet.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
