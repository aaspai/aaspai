import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@aaspai/contracts/primitives";
import {
  eq,
  getDefaultDb,
  runMigrations,
  sessions as sessionsTable,
} from "@aaspai/db";
import {
  DEFAULT_AGENTS_DIR,
  DEFAULT_KNOWLEDGE_DIR,
  FileAgentConfigSource,
  FileKnowledgeSource,
} from "@aaspai/file-loader";
import { SandboxManager } from "@aaspai/runtime";
import { Sessions } from "@aaspai/sessions";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgent, isAaspaiWorkspace, workspaceRoot } from "@/lib/aaspai";
import { chatRuntimeSchema, resolveChatRuntime } from "@/lib/chat-runtime";
import { currentUser } from "@/lib/local-auth";

interface SessionExecuteResume {
  sessionId: string;
  sessionParams?: JsonObject;
}

const bodySchema = z.object({
  message: z.string().min(1).max(1_048_576),
  adapter: z.string().optional(),
  model: z.string().nullable().optional(),
  runtime: chatRuntimeSchema.optional(),
  // Continue an existing conversation thread: the previous turn's row id
  // becomes this turn's parent; the previous turn's runtime session id
  // lets the adapter resume with memory (`--session`).
  parentSessionId: z.string().min(1).max(512).optional(),
  resumeSessionId: z.string().min(1).max(512).nullable().optional(),
  resumeSessionParams: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string[] }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
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
  const root = workspaceRoot();
  const agentSource = new FileAgentConfigSource(join(root, DEFAULT_AGENTS_DIR));
  const knowledgeSource = new FileKnowledgeSource(join(root, DEFAULT_KNOWLEDGE_DIR));
  await agentSource.start();
  await knowledgeSource.start();

  const db = getDefaultDb();
  runMigrations(db);

  // Validate the parent turn (if continuing a thread): it must exist,
  // belong to the user's org, and target the same agent — otherwise a
  // cross-org or cross-agent turn could hijack another conversation.
  let parentSessionId: string | undefined;
  let resume: SessionExecuteResume | undefined;
  if (body.parentSessionId) {
    const [parent] = await db.db
      .select({
        organizationId: sessionsTable.organizationId,
        agentId: sessionsTable.agentId,
      })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, body.parentSessionId))
      .limit(1);
    if (!parent || parent.organizationId !== user.organizationId || parent.agentId !== agentId) {
      await agentSource.stop().catch(() => undefined);
      await knowledgeSource.stop().catch(() => undefined);
      return NextResponse.json({ error: "parent session not found" }, { status: 404 });
    }
    parentSessionId = body.parentSessionId;
    if (body.resumeSessionId) {
      resume = {
        sessionId: body.resumeSessionId,
        ...(body.resumeSessionParams
          ? { sessionParams: body.resumeSessionParams as JsonObject }
          : {}),
      };
    }
  }

  // Resolve the execution target: body override → agent.runtime.default
  // → local. A malformed body override is a 400; an invalid agent
  // default silently degrades to local.
  const agentConfig = await agentSource.get(agentId);
  const runtimeResolved = resolveChatRuntime(body.runtime, agentConfig?.runtime);
  if (!runtimeResolved.ok) {
    await agentSource.stop().catch(() => undefined);
    await knowledgeSource.stop().catch(() => undefined);
    return NextResponse.json({ error: runtimeResolved.error }, { status: 400 });
  }
  const runtime = runtimeResolved.runtime;

  const sessions = new Sessions({
    agentSource,
    knowledgeSource,
    skillRegistry: undefined as never,
    // Chat sandboxes hold a minimal, re-derivable workspace, so a dead
    // lease may be safely replaced (OpenSwe's "allow_replacement" for
    // disposable sandboxes). Background/worker runs use the safer
    // default (raise on unreachable instead of replacing).
    sandboxManager: new SandboxManager({ allowReplacement: true }),
  });

  const sessionId = `sess_${randomUUID()}`;
  const requestId = `chat_${randomUUID()}`;
  const now = new Date().toISOString();

  // Pre-insert the session row so the SSE stream can find it the moment
  // the client connects. `Sessions.execute()` detects the existing row
  // (via `durableSessionId`) and updates it with the run details,
  // transitioning `queued` → `running` only when execution actually
  // begins. Durable `queued` (not `running`) is returned so a process
  // crash before the run starts never leaves a falsely-running row.
  await db.db.insert(sessionsTable).values({
    id: sessionId,
    organizationId: user.organizationId,
    wakeupId: requestId,
    agentId,
    adapter,
    runtimeJson: JSON.stringify(runtime),
    prompt: body.message,
    configJson: JSON.stringify({}),
    status: "queued",
    sessionDisplayId: sessionId.slice(0, 8),
    startedAt: now,
  } as never);

  // Run the session in the background. The client tails
  // `/api/sessions/{id}/stream` for live events and the final reply.
  // We do NOT await — the POST returns immediately with the session id.
  //
  // For sandbox runtimes, use a minimal empty cwd so the runtime's
  // workspace roundtrip doesn't upload the whole (multi-GB) repo — a
  // chat turn doesn't need the codebase in the sandbox.
  const sandboxCwd =
    runtime.kind === "sandbox" ? mkdtempSync(join(tmpdir(), "aaspai-chat-ws-")) : root;
  void (async () => {
    try {
      await sessions.execute({
        durableSessionId: sessionId,
        organizationId: user.organizationId,
        agentId,
        adapter,
        runtime,
        cwd: sandboxCwd,
        prompt: body.message,
        config: {},
        skills: [],
        budget: {},
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(resume ? { resume } : {}),
        idempotencyKey: requestId,
        wakeupId: requestId,
        traceId: requestId,
      });
    } catch (err) {
      // Mark the row failed so the stream terminates instead of hanging.
      await db.db
        .update(sessionsTable)
        .set({
          status: "failed",
          finishedAt: new Date().toISOString(),
          errorMessage: err instanceof Error ? err.message : String(err),
        } as never)
        .where({ id: sessionId } as never)
        .catch(() => undefined);
    } finally {
      // Best-effort: stop the file sources so chokidar releases handles.
      await agentSource.stop().catch(() => undefined);
      await knowledgeSource.stop().catch(() => undefined);
      if (sandboxCwd !== root) {
        try {
          rmSync(sandboxCwd, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  })();

  return NextResponse.json({ sessionId, status: "queued" });
}
