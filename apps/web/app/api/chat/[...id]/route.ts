import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FileAgentConfigSource, FileKnowledgeSource } from "@aaspai/file-loader";
import { Sessions } from "@aaspai/sessions";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgent, isAaspaiWorkspace, workspaceRoot } from "@/lib/aaspai";

const bodySchema = z.object({
  message: z.string().min(1).max(1_048_576),
  adapter: z.string().optional(),
  model: z.string().optional(),
});

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string[] }> }) {
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const { id: parts } = await params;
  // The catch-all `[...id]` lets `/api/chat/agent/ceo` route to a
  // single handler. Join the segments and normalize.
  const joined = (parts ?? []).join("/");
  const agentId = joined.startsWith("agent/") ? joined : `agent/${joined}`;

  const agent = await getAgent(agentId);
  if (!agent) {
    return NextResponse.json({ error: `agent ${agentId} not found` }, { status: 404 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json({ error: "invalid request", details: String(err) }, { status: 400 });
  }

  const adapter = body.adapter ?? agent.adapter;
  const _model = body.model ?? agent.model ?? "default";

  const root = workspaceRoot();
  const agentSource = new FileAgentConfigSource(join(root, "agents"));
  const knowledgeSource = new FileKnowledgeSource(join(root, "knowledge"));
  await agentSource.start();
  await knowledgeSource.start();

  const sessions = new Sessions({
    agentSource,
    knowledgeSource,
    skillRegistry: undefined as never,
  });

  const requestId = `chat_${randomUUID()}`;

  // Send the single-turn message; the dry-run adapter responds based
  // on the agent's role. Real adapters would do the full agentic loop.
  const result = await sessions.execute({
    organizationId: "default",
    agentId,
    adapter,
    runtime: { kind: "local" },
    prompt: body.message,
    config: {},
    skills: [],
    budget: {},
    idempotencyKey: requestId,
    wakeupId: requestId,
    traceId: requestId,
  });

  // Pull the response text from the result.
  const r = result as {
    status?: string;
    sessionId?: string;
    logRef?: string;
    resultJson?: { text?: string; response?: string };
    summary?: string;
    errorMessage?: string;
  };

  let reply = "";
  if (r.resultJson?.text) reply = r.resultJson.text;
  else if (r.resultJson?.response) reply = r.resultJson.response;
  else if (r.summary) reply = r.summary;

  if (r.status === "failed") {
    reply = `(${r.errorMessage ?? "session failed"})`;
  }

  if (!reply) reply = "(no response)";

  // Best-effort: stop the file sources so chokidar releases handles.
  // The HTTP request is short-lived so this is fine.
  await agentSource.stop().catch(() => undefined);
  await knowledgeSource.stop().catch(() => undefined);

  return NextResponse.json({
    reply,
    sessionId: r.logRef ?? r.sessionId,
    providerSessionId: r.sessionId,
    status: r.status ?? "completed",
  });
}
