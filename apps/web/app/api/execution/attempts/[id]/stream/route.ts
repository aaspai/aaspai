import { agentAttempts, desc, eq, executionEvents, getDefaultDb, sessionEvents } from "@aaspai/db";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "lost"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Authentication required", { status: 401 });
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  const attemptId = decodeURIComponent((await params).id);
  const [initial] = await handle.db
    .select()
    .from(agentAttempts)
    .where(eq(agentAttempts.id, attemptId))
    .limit(1);
  if (!initial) return new Response("Attempt not found", { status: 404 });
  if (initial.organizationId !== user.organizationId)
    return new Response("Organization access denied", { status: 403 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let lastId = request.headers.get("last-event-id") ?? "";
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        controller.close();
      };
      const poll = async () => {
        if (closed) return;
        try {
          const [attempt] = await handle.db
            .select()
            .from(agentAttempts)
            .where(eq(agentAttempts.id, attemptId))
            .limit(1);
          if (!attempt || attempt.organizationId !== user.organizationId) return close();
          const [execution] = await handle.db
            .select({ id: executionEvents.id })
            .from(executionEvents)
            .where(eq(executionEvents.attemptId, attemptId))
            .orderBy(desc(executionEvents.id))
            .limit(1);
          const [session] = attempt.harnessSessionId
            ? await handle.db
                .select({ id: sessionEvents.id })
                .from(sessionEvents)
                .where(eq(sessionEvents.sessionId, attempt.harnessSessionId))
                .orderBy(desc(sessionEvents.id))
                .limit(1)
            : [];
          const id = `${attempt.status}:${execution?.id ?? 0}:${session?.id ?? 0}`;
          if (id !== lastId) {
            lastId = id;
            controller.enqueue(
              encoder.encode(
                `id: ${id}\nevent: update\ndata: ${JSON.stringify({ status: attempt.status })}\n\n`,
              ),
            );
          } else {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
          if (TERMINAL.has(attempt.status)) close();
        } catch {
          // Transient DB error — keep streaming (next tick retries) rather
          // than permanently killing the stream (sibling SSE routes do the
          // same; a momentary read error must not drop a live run).
        }
      };
      const timer = setInterval(() => void poll().catch(close), 1_000);
      request.signal.addEventListener("abort", close, { once: true });
      void poll().catch(close);
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    },
  });
}
