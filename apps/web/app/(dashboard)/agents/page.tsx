import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAgentHierarchy, isAaspaiWorkspace } from "@/lib/aaspai";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  ceo: "Chief of Staff",
  cto: "CTO",
  cmo: "Marketing",
  cfo: "Finance",
  security: "Security",
  engineer: "Engineer",
  designer: "Designer",
  pm: "PM",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
  operator: "Operator",
  general: "Generalist",
};

const ADAPTER_LABEL: Record<string, string> = {
  dry_run_local: "Dry-run",
  claude_local: "Claude (CLI)",
  codex_local: "Codex (CLI)",
  opencode_local: "OpenCode (HTTP)",
  opencode_cli: "OpenCode (CLI)",
  cursor_local: "Cursor (CLI)",
  cursor_cloud: "Cursor (Cloud)",
  openclaw_gateway: "OpenClaw",
  hermes_gateway: "Hermes",
};

export default async function AgentsPage() {
  if (!isAaspaiWorkspace()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No aaspai workspace</CardTitle>
          <CardDescription>
            Run <code className="rounded bg-muted px-1 py-0.5 text-xs">aaspai init</code> in your
            project first.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { agents, roots } = await getAgentHierarchy();
  const childrenOf = new Map<string, string[]>();
  for (const a of agents) {
    if (a.reportsTo) {
      const list = childrenOf.get(a.reportsTo) ?? [];
      list.push(a.id);
      childrenOf.set(a.reportsTo, list);
    }
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">
            {agents.length} {agents.length === 1 ? "employee" : "employees"} on the team.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/chat/agent/ceo">Talk to CEO</Link>
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Team hierarchy</CardTitle>
          <CardDescription>
            Who reports to whom. The CEO at the top is the user-facing entry point.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {roots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents yet.</p>
          ) : (
            <ul className="space-y-1">
              {roots.map((rootId) => (
                <TreeNode
                  key={rootId}
                  id={rootId}
                  agents={agents}
                  childrenOf={childrenOf}
                  depth={0}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a) => (
          <Link
            key={a.id}
            href={`/agents/${a.id}`}
            className="block transition-opacity hover:opacity-80"
          >
            <Card className="h-full">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{a.title}</CardTitle>
                    <CardDescription className="mt-0.5 text-xs">{a.id}</CardDescription>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{ROLE_LABEL[a.role] ?? a.role}</Badge>
                  <Badge variant="outline">{ADAPTER_LABEL[a.adapter] ?? a.adapter}</Badge>
                  {a.model && (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {a.model}
                    </Badge>
                  )}
                </div>
                {a.manages.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Manages {a.manages.length} {a.manages.length === 1 ? "person" : "people"}
                  </p>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>
    </div>
  );
}

function TreeNode({
  id,
  agents,
  childrenOf,
  depth,
}: {
  id: string;
  agents: Awaited<ReturnType<typeof getAgentHierarchy>>["agents"];
  childrenOf: Map<string, string[]>;
  depth: number;
}) {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return null;
  const children = childrenOf.get(id) ?? [];
  return (
    <li>
      <div
        className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40")}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="font-medium">{agent.title}</span>
        <span className="text-xs text-muted-foreground">{agent.id}</span>
        <Badge variant="outline" className="text-[10px]">
          {ADAPTER_LABEL[agent.adapter] ?? agent.adapter}
        </Badge>
        <Link
          href={`/agents/${agent.id}`}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
        >
          view →
        </Link>
      </div>
      {children.length > 0 && (
        <ul>
          {children.map((cid) => (
            <TreeNode
              key={cid}
              id={cid}
              agents={agents}
              childrenOf={childrenOf}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
