"use client";

import { ArrowLeft, Check, MoreHorizontal, Send } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProjectEvaluationControls } from "@/components/project-evaluation-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Task = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  owner: string | null;
  updatedAt: string;
  blockedReason: string | null;
  dependencyIds: string[];
  evidenceCount: number;
  projectId: string;
};
type Project = {
  id: string;
  title: string;
  description: string;
  status: string;
  repositoryCount: number;
};

const statuses = [
  "all",
  "proposed",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "completed",
  "failed",
];

export function ProjectWorkspace({
  project,
  tasks,
  milestones = [],
}: {
  project: Project;
  tasks: Task[];
  milestones?: Array<{ id: string; title: string; status: string }>;
}) {
  const [filter, setFilter] = useState("all");
  const visible = useMemo(
    () => (filter === "all" ? tasks : tasks.filter((task) => task.status === filter)),
    [filter, tasks],
  );
  return (
    <div className="space-y-6">
      <Link
        href="/projects"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        All projects
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">{project.title}</h1>
            <Badge>{project.status.replaceAll("_", " ")}</Badge>
          </div>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            {project.description || "No project description yet."}
          </p>
        </div>
      </header>
      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="Tasks" value={tasks.length} />
        <Metric
          label="In progress"
          value={tasks.filter((t) => t.status === "in_progress").length}
        />
        <Metric label="Blocked" value={tasks.filter((t) => t.status === "blocked").length} />
        <Metric label="Completed" value={tasks.filter((t) => t.status === "completed").length} />
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Tasks</CardTitle>
              <CardDescription>
                Track status, ownership, dependencies, and execution evidence.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-1">
              {statuses.map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setFilter(status)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs capitalize",
                    filter === status
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {status.replaceAll("_", " ")}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {visible.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
            {visible.length === 0 && (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No tasks in this status.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Project setup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Link
              href={`/projects/${encodeURIComponent(project.id)}/settings`}
              className="block rounded-md border px-3 py-2 hover:bg-muted"
            >
              Settings
            </Link>
            <Link
              href={`/projects/${encodeURIComponent(project.id)}/agents`}
              className="block rounded-md border px-3 py-2 hover:bg-muted"
            >
              Agents
            </Link>
            <Link
              href={`/projects/${encodeURIComponent(project.id)}/files`}
              className="block rounded-md border px-3 py-2 hover:bg-muted"
            >
              Files
            </Link>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Project activity</CardTitle>
            <CardDescription>
              Comments, status changes, approvals, and task updates.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Activity text="Project workspace is ready for execution" />
            <Activity text={`${tasks.length} tasks are currently tracked`} />
            <Activity text="Repository and agent settings are available" />
          </CardContent>
        </Card>
      </div>
      <ProjectEvaluationControls projectId={project.id} milestones={milestones} />
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <Link
      href={`/tasks/${encodeURIComponent(task.id)}`}
      className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-muted/40"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
            task.status === "completed"
              ? "bg-emerald-500"
              : task.status === "blocked" || task.status === "failed"
                ? "bg-red-500"
                : "bg-amber-500",
          )}
        />
        <div className="min-w-0">
          <p className="truncate font-medium">{task.title}</p>
          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
            {task.description || "No description"}
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{task.owner?.replace(/^agent\//, "") || "Unassigned"}</span>
            <span>Priority {task.priority}</span>
            <span>{task.evidenceCount} evidence</span>
            {task.dependencyIds.length > 0 && <span>{task.dependencyIds.length} dependencies</span>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge
          variant={
            task.status === "failed"
              ? "destructive"
              : task.status === "in_progress"
                ? "default"
                : "secondary"
          }
        >
          {task.status.replaceAll("_", " ")}
        </Badge>
        <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
      </div>
    </Link>
  );
}
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}
function Activity({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
      <Check className="h-4 w-4 text-emerald-500" />
      {text}
    </div>
  );
}

export function TaskWorkspace({
  task,
  projectTitle,
  comments,
}: {
  task: Task;
  projectTitle: string;
  comments: Array<{ id: string; author: string; body: string; timestamp: string }>;
}) {
  const [status, setStatus] = useState(task.status);
  const [items, setItems] = useState(comments);
  const [draft, setDraft] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const loadDiscussion = useCallback(async () => {
    const threadsResponse = await fetch(
      `/api/company/threads?entityType=work&entityId=${encodeURIComponent(task.id)}`,
    );
    if (!threadsResponse.ok) return;
    const threadBody = (await threadsResponse.json()) as { data?: Array<{ id: string }> };
    let id = threadBody.data?.[0]?.id;
    if (!id) {
      const createResponse = await fetch("/api/company/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entityType: "work",
          entityId: task.id,
          title: `Discussion: ${task.title}`,
          idempotencyKey: `thread:${task.id}`,
        }),
      });
      const created = (await createResponse.json().catch(() => ({}))) as {
        data?: { id?: string };
      };
      id = created.data?.id;
    }
    if (!id) return;
    setThreadId(id);
    const messagesResponse = await fetch(`/api/company/threads/${encodeURIComponent(id)}/messages`);
    if (!messagesResponse.ok) return;
    const messages = (await messagesResponse.json()) as {
      data?: Array<{ id: string; authorId: string; body: string; createdAt: string }>;
    };
    setItems([
      ...comments,
      ...(messages.data ?? []).map((message) => ({
        id: message.id,
        author: message.authorId,
        body: message.body,
        timestamp: message.createdAt,
      })),
    ]);
  }, [comments, task.id, task.title]);
  useEffect(() => {
    void loadDiscussion();
  }, [loadDiscussion]);
  async function changeStatus(nextStatus: string) {
    setStatus(nextStatus);
    const response = await fetch(`/api/work/${encodeURIComponent(task.id)}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (!response.ok) setStatus(task.status);
  }
  async function addComment() {
    const body = draft.trim();
    if (!body) return;
    const id = crypto.randomUUID();
    const optimistic = { id, author: "You", body, timestamp: "Just now" };
    setItems((current) => [...current, optimistic]);
    setDraft("");
    const targetThread = threadId ?? (await getOrCreateThread());
    if (!targetThread) {
      setItems((current) => current.filter((item) => item.id !== id));
      return;
    }
    const response = await fetch(
      `/api/company/threads/${encodeURIComponent(targetThread)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, idempotencyKey: `message:${id}` }),
      },
    );
    if (!response.ok) {
      // Roll back the optimistic comment; keep whatever the server holds.
      setItems((current) => current.filter((item) => item.id !== id));
      return;
    }
    // Reconcile: reload so the persisted message replaces the optimistic
    // placeholder (its temp id). Merge rather than replace so nothing the
    // user typed is dropped mid-flight.
    await loadDiscussion();
  }

  // Resolve the durable thread id for this work item, creating it when
  // missing. Does NOT reload the discussion items — that happens after
  // the POST so the optimistic comment isn't dropped before it persists.
  async function getOrCreateThread(): Promise<string | null> {
    const threadsResponse = await fetch(
      `/api/company/threads?entityType=work&entityId=${encodeURIComponent(task.id)}`,
    );
    if (!threadsResponse.ok) return null;
    const threadBody = (await threadsResponse.json()) as { data?: Array<{ id: string }> };
    let id = threadBody.data?.[0]?.id;
    if (!id) {
      const createResponse = await fetch("/api/company/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entityType: "work",
          entityId: task.id,
          title: `Discussion: ${task.title}`,
          idempotencyKey: `thread:${task.id}`,
        }),
      });
      const created = (await createResponse.json().catch(() => ({}))) as {
        data?: { id?: string };
      };
      id = created.data?.id;
    }
    if (!id) return null;
    setThreadId(id);
    return id;
  }
  return (
    <div className="space-y-6">
      <Link
        href={`/projects/${encodeURIComponent(task.projectId)}`}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {projectTitle}
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">{task.title}</h1>
            <Badge
              variant={
                status === "failed"
                  ? "destructive"
                  : status === "in_progress"
                    ? "default"
                    : "secondary"
              }
            >
              {status.replaceAll("_", " ")}
            </Badge>
          </div>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            {task.description || "No description provided."}
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={status}
            onChange={(event) => void changeStatus(event.target.value)}
            aria-label="Change task status"
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="proposed">Proposed</option>
            <option value="ready">Ready</option>
            <option value="in_progress">In progress</option>
            <option value="blocked">Blocked</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </header>
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <main className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Comments and activity</CardTitle>
              <CardDescription>Keep decisions and handoffs attached to the task.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {items.map((comment) => (
                  <div key={comment.id} className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {comment.author.slice(0, 1)}
                    </div>
                    <div className="min-w-0 flex-1 rounded-lg border px-3 py-2">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="text-sm font-medium">{comment.author}</span>
                        <span className="text-xs text-muted-foreground">{comment.timestamp}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                        {comment.body}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Write a comment or handoff…"
                  aria-label="Write a comment"
                  className="min-h-20 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                />
                <Button onClick={addComment} size="icon" aria-label="Add comment">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Execution evidence</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {task.evidenceCount
                  ? `${task.evidenceCount} evidence records are attached to this task.`
                  : "No evidence recorded yet."}
              </p>
            </CardContent>
          </Card>
        </main>
        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Task details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Detail label="Project" value={projectTitle} />
              <Detail
                label="Assignee"
                value={task.owner?.replace(/^agent\//, "") || "Unassigned"}
              />
              <Detail label="Priority" value={String(task.priority)} />
              <Detail label="Updated" value={task.updatedAt} />
              <Detail label="Dependencies" value={String(task.dependencyIds.length)} />
              {task.blockedReason && <Detail label="Blocked reason" value={task.blockedReason} />}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
