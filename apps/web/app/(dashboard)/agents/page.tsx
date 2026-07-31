import { Bot, Network } from "lucide-react";
import { AgentGraph } from "@/components/agent-graph";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAgentHierarchy, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  if (!isAaspaiWorkspace())
    return (
      <Card>
        <CardHeader>
          <CardTitle>No aaspai workspace</CardTitle>
          <CardDescription>
            Run <code className="rounded bg-muted px-1 text-xs">aaspai init</code> first.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  const { agents } = await getAgentHierarchy();
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5" />
            <h1 className="text-3xl font-semibold tracking-tight">Agents</h1>
            <Badge variant="secondary">{agents.length} nodes</Badge>
          </div>
          <p className="mt-2 text-muted-foreground">
            A live view of the AI workforce and its reporting edges.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline">
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500" />
            Available
          </Badge>
          <Badge variant="outline">
            <Bot className="mr-1.5 inline-block h-3 w-3" />
            Agent node
          </Badge>
        </div>
      </header>
      <AgentGraph agents={agents} />
    </div>
  );
}
