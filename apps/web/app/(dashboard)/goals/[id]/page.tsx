import { ArrowLeft, CheckCircle2, Circle, Clock3 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCompanyOverview, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isAaspaiWorkspace()) notFound();
  const { id } = await params;
  const overview = await getCompanyOverview();
  const goal = overview.goals.find((item) => item.id === decodeURIComponent(id));
  if (!goal) notFound();
  const work = overview.workItems.filter((item) => item.goalId === goal.id);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/goals">
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Goals
        </Link>
      </Button>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{goal.title}</h1>
          <Badge variant="secondary">{goal.status}</Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{goal.description}</p>
      </header>
      <section className="grid gap-3 sm:grid-cols-4">
        <Metric label="Progress" value={`${goal.percent}%`} />
        <Metric label="Completed" value={`${goal.completed}/${goal.total}`} />
        <Metric label="Active" value={String(goal.active)} />
        <Metric label="Blocked" value={String(goal.blocked + goal.failed)} />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Projects in this goal</CardTitle>
          <CardDescription>
            Projects translate the objective into owned execution areas.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {overview.projects
            .filter((project) => project.goalId === goal.id)
            .map((project) => (
              <Link
                key={project.id}
                href={`/projects/${encodeURIComponent(project.id)}`}
                className="rounded-lg border p-4 hover:bg-accent/40"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{project.title}</span>
                  <Badge variant="secondary">{project.status}</Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {project.description || "No description yet."}
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  {project.repositoryCount} repositories
                </p>
              </Link>
            ))}
          {overview.projects.filter((project) => project.goalId === goal.id).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No projects are attached to this goal yet.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Operating plan</CardTitle>
          <CardDescription>Every work item contributing to this objective.</CardDescription>
        </CardHeader>
        <CardContent>
          {work.length ? (
            <div className="divide-y">
              {work.map((item) => (
                <Link
                  key={item.id}
                  href={`/tasks/${encodeURIComponent(item.id)}`}
                  className="flex items-center gap-3 py-4 hover:bg-accent/40"
                >
                  {item.status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : item.status === "ready" ? (
                    <Clock3 className="h-4 w-4 text-blue-600" />
                  ) : (
                    <Circle className="h-4 w-4" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{item.title}</p>
                    <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                  <Badge variant="outline">{item.status.replaceAll("_", " ")}</Badge>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No work items yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
