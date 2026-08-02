"use client";

import { Filter, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Issue = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  owner: string | null;
  projectId: string;
  projectTitle: string | null;
  goalId: string;
  dependencyIds: string[];
  evidenceCount: number;
};
const columns = [
  { key: "proposed", label: "Backlog" },
  { key: "ready", label: "Todo" },
  { key: "in_progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "completed", label: "Done" },
];

export function IssuesBoard({ issues }: { issues: Issue[] }) {
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState("all");
  const filtered = issues.filter(
    (issue) =>
      `${issue.title} ${issue.description} ${issue.projectTitle ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (priority === "all" || String(issue.priority) === priority),
  );
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Work management
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Issues</h1>
          <p className="mt-2 text-muted-foreground">
            A single board for every task across goals and projects.
          </p>
        </div>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New issue
        </Button>
      </header>
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search issues, projects, or descriptions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <select
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
          className="rounded-md border bg-background px-3 text-sm"
        >
          <option value="all">All priorities</option>
          <option value="3">High priority</option>
          <option value="2">Medium priority</option>
          <option value="1">Low priority</option>
        </select>
        <Button variant="outline">
          <Filter className="mr-2 h-4 w-4" />
          Filters
        </Button>
      </div>
      <div className="grid gap-4 xl:grid-cols-5">
        {columns.map((column) => (
          <Card key={column.key} className="min-h-72 bg-muted/20">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">{column.label}</CardTitle>
                <Badge variant="secondary">
                  {filtered.filter((issue) => issue.status === column.key).length}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {filtered
                .filter((issue) => issue.status === column.key)
                .map((issue) => (
                  <IssueCard key={issue.id} issue={issue} />
                ))}
              {filtered.filter((issue) => issue.status === column.key).length === 0 && (
                <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                  No issues
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function IssueCard({ issue }: { issue: Issue }) {
  return (
    <Link
      href={`/tasks/${encodeURIComponent(issue.id)}`}
      className="block rounded-lg border bg-card p-3 shadow-sm transition hover:-translate-y-0.5 hover:border-foreground/30"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-sm font-medium">{issue.title}</p>
        <span
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${issue.priority >= 3 ? "bg-red-500" : issue.priority === 2 ? "bg-amber-500" : "bg-slate-400"}`}
        />
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
        {issue.description || "No description"}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="max-w-full truncate text-[10px]">
          {issue.projectTitle ?? issue.projectId}
        </Badge>
        {issue.owner && (
          <Badge variant="secondary" className="text-[10px]">
            {issue.owner.replace(/^agent\//, "")}
          </Badge>
        )}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        <span>P{issue.priority}</span>
        <span>
          {issue.evidenceCount} evidence
          {issue.dependencyIds.length ? ` · ${issue.dependencyIds.length} deps` : ""}
        </span>
      </div>
    </Link>
  );
}
