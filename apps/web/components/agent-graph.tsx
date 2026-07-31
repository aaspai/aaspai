"use client";

import { Minus, Plus, RotateCcw, UserRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Agent = {
  id: string;
  title: string;
  role: string;
  adapter: string;
  model: string | null;
  reportsTo: string | null;
  manages: string[];
  peers: string[];
};

const roleLabel: Record<string, string> = {
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
  operator: "Manager",
  general: "Generalist",
};

export function AgentGraph({ agents }: { agents: Agent[] }) {
  const [selected, setSelected] = useState(agents[0]?.id ?? "");
  const [zoom, setZoom] = useState(1);
  const layout = useMemo(() => {
    const levels = new Map<string, number>();
    function depth(agent: Agent, trail = new Set<string>()): number {
      if (!agent.reportsTo || trail.has(agent.id)) return 0;
      const parent = agents.find((candidate) => candidate.id === agent.reportsTo);
      return parent ? depth(parent, new Set([...trail, agent.id])) + 1 : 0;
    }
    for (const agent of agents) levels.set(agent.id, depth(agent));
    const grouped = new Map<number, Agent[]>();
    for (const agent of agents) {
      const list = grouped.get(levels.get(agent.id) ?? 0) ?? [];
      list.push(agent);
      grouped.set(levels.get(agent.id) ?? 0, list);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [level, list] of grouped) {
      list.forEach((agent, index) => {
        positions.set(agent.id, { x: 180 + index * 260, y: 90 + level * 180 });
      });
    }
    return {
      positions,
      width: Math.max(
        820,
        ...[...grouped.values()].map((list) => 180 + (list.length - 1) * 260 + 240),
      ),
      height: Math.max(520, (Math.max(...levels.values(), 0) + 1) * 180 + 80),
    };
  }, [agents]);
  const active = agents.find((agent) => agent.id === selected);
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
      <Card className="min-w-0">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Agent organization graph</CardTitle>
              <CardDescription>
                Reporting relationships, operating roles, and connected agents.
              </CardDescription>
            </div>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="icon"
                aria-label="Zoom out"
                onClick={() => setZoom((value) => Math.max(0.7, value - 0.1))}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Reset zoom"
                onClick={() => setZoom(1)}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Zoom in"
                onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border bg-muted/20">
            <div
              className="relative"
              style={{ width: layout.width * zoom, height: layout.height * zoom }}
            >
              <div
                className="absolute left-0 top-0 origin-top-left"
                style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
              >
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  aria-hidden="true"
                >
                  {agents
                    .filter((agent) => agent.reportsTo && layout.positions.has(agent.reportsTo))
                    .map((agent) => {
                      const parentId = agent.reportsTo;
                      const child = layout.positions.get(agent.id);
                      const parent = parentId ? layout.positions.get(parentId) : undefined;
                      if (!child || !parent) return null;
                      return (
                        <path
                          key={agent.id}
                          d={`M ${parent.x + 105} ${parent.y + 72} C ${parent.x + 105} ${parent.y + 125}, ${child.x + 105} ${child.y - 55}, ${child.x + 105} ${child.y}`}
                          fill="none"
                          stroke="hsl(var(--border))"
                          strokeWidth="2"
                        />
                      );
                    })}
                </svg>
                {agents.map((agent) => {
                  const position = layout.positions.get(agent.id);
                  if (!position) return null;
                  const isSelected = selected === agent.id;
                  return (
                    <button
                      type="button"
                      key={agent.id}
                      onClick={() => setSelected(agent.id)}
                      className={cn(
                        "absolute w-[210px] rounded-xl border bg-card p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md",
                        isSelected && "border-primary ring-2 ring-primary/20",
                      )}
                      style={{ left: position.x, top: position.y }}
                    >
                      <div className="flex items-start gap-2">
                        <div className="rounded-lg bg-muted p-2">
                          <UserRound className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{agent.title}</p>
                          <p className="truncate text-xs text-muted-foreground">{agent.id}</p>
                        </div>
                        <span className="ml-auto mt-1 h-2 w-2 rounded-full bg-emerald-500" />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1">
                        <Badge variant="secondary" className="text-[10px]">
                          {roleLabel[agent.role] ?? agent.role}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {agent.manages.length} reports
                        </Badge>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>{active?.title ?? "Select an agent"}</CardTitle>
          <CardDescription>
            {active ? "Agent node details" : "Click a node to inspect it."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {active ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge>{roleLabel[active.role] ?? active.role}</Badge>
                <Badge variant="outline">{active.adapter}</Badge>
              </div>
              <Detail label="Model" value={active.model ?? "Default"} />
              <Detail label="Reports to" value={active.reportsTo ?? "Workspace"} />
              <Detail label="Direct reports" value={String(active.manages.length)} />
              <Detail label="Peers" value={String(active.peers.length)} />
              <Button asChild className="w-full">
                <Link href={`/agents/${encodeURIComponent(active.id)}`}>Open agent profile</Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href={`/chat/${encodeURIComponent(active.id)}`}>Start conversation</Link>
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Choose a node from the graph.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
