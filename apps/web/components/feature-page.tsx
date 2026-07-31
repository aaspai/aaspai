import { ArrowUpRight, CheckCircle2, CircleDot, Clock3, Plus, Search } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const pageCatalog: Record<string, { title: string; description: string; parent?: string }> =
  {
    "auth/invite": {
      title: "Workspace invitation",
      description: "Accept an invitation and join the AI workspace.",
    },
    dashboard: {
      title: "Command center",
      description: "Monitor work, agents, approvals, and operating health.",
    },
    "projects/new": {
      title: "Create project",
      description: "Start a governed workspace for a new initiative.",
    },
    "projects/settings": {
      title: "Project settings",
      description: "Configure project behavior, access, providers, and defaults.",
    },
    "projects/tasks": {
      title: "Project tasks",
      description: "Plan, assign, and track work inside this project.",
    },
    "projects/files": {
      title: "Project files",
      description: "Browse project documents, uploads, and generated artifacts.",
    },
    "projects/sessions": {
      title: "Project sessions",
      description: "Review agent sessions and execution history for this project.",
    },
    "projects/agents": {
      title: "Project agents",
      description: "Choose the agents available to this project.",
    },
    "projects/automations": {
      title: "Project automations",
      description: "Schedule recurring work and event-driven workflows.",
    },
    "work/queue": {
      title: "Work queue",
      description: "Prioritized work waiting for an agent or human decision.",
    },
    "work/runs": {
      title: "Run history",
      description: "Inspect active and completed execution runs.",
    },
    "work/logs": {
      title: "Execution logs",
      description: "Trace events, tool calls, and runtime output.",
    },
    "work/audit": {
      title: "Execution audit",
      description: "Review the complete history of sensitive actions.",
    },
    "agents/new": {
      title: "Create agent",
      description: "Define an agent identity, tools, permissions, and instructions.",
    },
    "agents/memory": {
      title: "Agent memory",
      description: "Inspect durable context and learned operating patterns.",
    },
    "agents/sessions": {
      title: "Agent sessions",
      description: "Review conversations and runs for this agent.",
    },
    "governance/policies": {
      title: "Policies",
      description: "Define approval, access, and safety rules for the workspace.",
    },
    "governance/decisions": {
      title: "Decisions",
      description: "Record durable decisions and the reasoning behind them.",
    },
    "governance/review-queue": {
      title: "Review queue",
      description: "Resolve proposals, escalations, and sensitive changes.",
    },
    "knowledge/documents": {
      title: "Knowledge documents",
      description: "Manage the documents available to agents.",
    },
    "knowledge/proposals": {
      title: "Knowledge proposals",
      description: "Review proposed additions and corrections to knowledge.",
    },
    "memory/learnings": {
      title: "Learnings",
      description: "Capture reusable patterns from completed work.",
    },
    "integrations/api-keys": {
      title: "API keys",
      description: "Manage keys used by workspace integrations.",
    },
    "integrations/secrets": {
      title: "Secrets",
      description: "Securely manage environment variables and credentials.",
    },
    "integrations/git": {
      title: "Git providers",
      description: "Connect repositories and control source-code access.",
    },
    "integrations/webhooks": {
      title: "Webhooks",
      description: "Receive events and trigger reliable workflows.",
    },
    "integrations/channels": {
      title: "Communication channels",
      description: "Connect email, chat, and notification destinations.",
    },
    "automations/schedules": {
      title: "Schedules",
      description: "Create recurring routines for agents and projects.",
    },
    "automations/webhooks": {
      title: "Automation triggers",
      description: "Start work when external events arrive.",
    },
    "automations/history": {
      title: "Automation history",
      description: "Review runs, failures, retries, and outcomes.",
    },
    "org/members": {
      title: "Members",
      description: "Invite people and manage workspace membership.",
    },
    "org/teams": {
      title: "Teams and groups",
      description: "Organize people and agents around shared work.",
    },
    "org/roles": {
      title: "Roles and permissions",
      description: "Control access to projects, tools, and sensitive actions.",
    },
    "org/billing": {
      title: "Billing and usage",
      description: "Review plan, spend, invoices, and consumption.",
    },
    "org/audit": {
      title: "Organization audit log",
      description: "Track membership and configuration changes.",
    },
    "settings/profile": {
      title: "Personal profile",
      description: "Update your identity and workspace preferences.",
    },
    "settings/notifications": {
      title: "Notifications",
      description: "Choose when the workspace should notify you.",
    },
    "settings/providers": {
      title: "Model providers",
      description: "Configure approved models and provider credentials.",
    },
    "settings/permissions": {
      title: "Session permissions",
      description: "Set safe defaults for browser, files, terminal, and tools.",
    },
    "settings/mcp": {
      title: "MCP connections",
      description: "Manage model-context protocol servers and capabilities.",
    },
  };

function titleFromSlug(slug: string[]) {
  return slug
    .map((part) => part.replace(/-/g, " "))
    .join(" / ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function FeaturePage({ slug }: { slug: string[] }) {
  const key = slug.join("/");
  const page = pageCatalog[key] ?? {
    title: titleFromSlug(slug),
    description: "A governed workspace surface for reliable AI work.",
  };
  const rows = [
    ["Ready for review", "Approval and policy checks", "Pending", "Now"],
    ["In progress", "Agent execution", "Working", "Today"],
    ["Completed", "Recent workspace activity", "Done", "Yesterday"],
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Workspace
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">{page.title}</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">{page.description}</p>
        </div>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Create
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm text-muted-foreground">Active</p>
            <p className="mt-1 text-2xl font-semibold">12</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm text-muted-foreground">Needs attention</p>
            <p className="mt-1 text-2xl font-semibold">3</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm text-muted-foreground">Completed</p>
            <p className="mt-1 text-2xl font-semibold">48</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Activity</CardTitle>
              <CardDescription>Mock records establish the final interaction shape.</CardDescription>
            </div>
            <Button variant="outline" size="icon" aria-label="Search">
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {rows.map(([name, detail, status, time]) => (
            <div
              key={name}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <CircleDot className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-xs text-muted-foreground">{detail}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={status === "Working" ? "default" : "secondary"}>{status}</Badge>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock3 className="h-3 w-3" />
                  {time}
                </span>
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        Back to command center <ArrowUpRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
