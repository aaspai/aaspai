import { FolderKanban, Plus, Search } from "lucide-react";
import Link from "next/link";
import { ProjectCommandForm } from "@/components/project-command-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCompanyOverview, getStrategicSummary, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  if (!isAaspaiWorkspace()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>Initialize a workspace to create and manage projects.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const overview = await getCompanyOverview();
  const strategic = await getStrategicSummary();
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Portfolio
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-2 text-muted-foreground">
            Projects group goals, repositories, agents, and tasks into an executable workspace.
          </p>
        </div>
        {strategic ? (
          <ProjectCommandForm
            objectives={strategic.objectives.map((objective) => ({
              id: objective.id,
              title: objective.title,
            }))}
          />
        ) : (
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            New project
          </Button>
        )}
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Search className="h-4 w-4" />
          Search projects
        </div>
        <div className="flex gap-2">
          <Badge variant="secondary">{overview.projects.length} projects</Badge>
          <Badge variant="outline">{overview.workItems.length} tasks</Badge>
        </div>
      </div>
      {strategic && (
        <Card>
          <CardHeader>
            <CardTitle>Strategic portfolio</CardTitle>
            <CardDescription>
              {strategic.projects.filter((project) => project.managerAgentId).length} staffed
              projects ·{" "}
              {strategic.projects.reduce((count, project) => count + project.milestones.length, 0)}{" "}
              milestones
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            {strategic.projects.slice(0, 6).map((project) => (
              <div key={project.id} className="rounded-lg border bg-background p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{project.title}</p>
                  <Badge variant="outline">{project.healthStatus}</Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {project.managerAgentId?.replace("agent/", "") ?? "Unstaffed"} ·{" "}
                  {project.milestones.length} milestones
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {overview.projects.map((project) => {
          const tasks = overview.workItems.filter((item) => item.projectId === project.id);
          const done = tasks.filter((item) => item.status === "completed").length;
          return (
            <Link
              key={project.id}
              href={`/projects/${encodeURIComponent(project.id)}`}
              className="group"
            >
              <Card className="h-full transition-colors group-hover:border-foreground/30">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg bg-muted p-2">
                        <FolderKanban className="h-5 w-5" />
                      </div>
                      <div>
                        <CardTitle>{project.title}</CardTitle>
                        <CardDescription className="mt-1">
                          {project.description || "No description yet."}
                        </CardDescription>
                      </div>
                    </div>
                    <Badge variant={project.status === "active" ? "default" : "secondary"}>
                      {project.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {tasks.length} tasks · {project.repositoryCount} repositories
                    </span>
                    <span className="font-medium">
                      {done}/{tasks.length || 0} complete
                    </span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{
                        width: `${tasks.length ? Math.round((done / tasks.length) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
      {overview.projects.length === 0 && (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            No projects yet. Create one from a goal or start a new project.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
