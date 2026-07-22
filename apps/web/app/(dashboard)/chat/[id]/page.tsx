import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getAgent, isAaspaiWorkspace } from "@/lib/aaspai";
import { ChatConsole } from "@/components/chat-console";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agentId = decodeURIComponent(id);
  if (!isAaspaiWorkspace()) notFound();
  const agent = await getAgent(agentId);
  if (!agent) notFound();

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/agents/${encodeURIComponent(agentId)}`}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Back to {agent.title}
          </Link>
        </Button>
        <div className="text-right">
          <div className="text-sm font-semibold">{agent.title}</div>
          <div className="text-xs text-muted-foreground">
            {agent.adapter} · {agent.model ?? "default model"}
          </div>
        </div>
      </div>
      <ChatConsole
        agentId={agent.id}
        agentTitle={agent.title}
        adapter={agent.adapter}
        model={agent.model ?? null}
      />
    </div>
  );
}
