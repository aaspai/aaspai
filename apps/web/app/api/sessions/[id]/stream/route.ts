import type { DbHandle } from "@aaspai/db";
import { and, eq, getDefaultDb, gt, sessionEvents, sessions } from "@aaspai/db";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted", "lost"]);
const POLL_MS = 800;

/**
 * SSE stream of `session_events` for a session, tailed live.
 *
 * Honours `Last-Event-ID` (a `seq`) so reconnects only receive events
 * after the client's cursor. Emits one `data:` frame per event as
 * `{seq, kind, payload, ts}` and closes when the session reaches a
 * terminal status.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return createSessionStreamHandler({ getDb: () => getDefaultDb() })(request, params);
}

/** Factory for the stream handler — testable with injected deps. */
export function createSessionStreamHandler(options: {
  getDb?: () => DbHandle;
  pollMs?: number;
  getUser?: () => Promise<{ id: string; organizationId: string } | null>;
  ensureWorkspace?: () => void;
}) {
  const getDb = options.getDb ?? (() => getDefaultDb());
  const pollMs = options.pollMs ?? POLL_MS;
  const getUser = options.getUser ?? currentUser;
  const ensureWorkspace = options.ensureWorkspace ?? ensureWorkspaceEnv;

  return async function handler(
    request: Request,
    params: Promise<{ id: string }>,
  ): Promise<Response> {
    const user = await getUser();
    if (!user) return new Response("Authentication required", { status: 401 });
    ensureWorkspace();
    const handle = getDb();
    const sessionId = decodeURIComponent((await params).id);

    const [initial] = await handle.db
      .select({
        id: sessions.id,
        status: sessions.status,
        organizationId: sessions.organizationId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!initial) return new Response("Session not found", { status: 404 });
    if (initial.organizationId !== user.organizationId)
      return new Response("Organization access denied", { status: 403 });

    const encoder = new TextEncoder();
    let lastSeq = Number.parseInt(request.headers.get("last-event-id") ?? "", 10);
    if (!Number.isFinite(lastSeq) || lastSeq < 0) lastSeq = 0;

    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let lastStatus = initial.status;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        const send = (id: string, event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        };
        const poll = async () => {
          if (closed) return;
          try {
            const [session] = await handle.db
              .select({ status: sessions.status, organizationId: sessions.organizationId })
              .from(sessions)
              .where(eq(sessions.id, sessionId))
              .limit(1);
            if (!session || session.organizationId !== user.organizationId) return close();

            const events = await handle.db
              .select()
              .from(sessionEvents)
              .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, lastSeq)))
              .orderBy(sessionEvents.seq)
              .limit(200);
            for (const event of events) {
              lastSeq = event.seq;
              let payload: Record<string, unknown> = {};
              try {
                payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
              } catch {
                payload = { raw: event.payloadJson };
              }
              send(String(event.seq), "event", {
                seq: event.seq,
                kind: event.kind,
                payload,
                ts: event.ts,
              });
            }

            if (session.status !== lastStatus) {
              lastStatus = session.status;
              send("status", "status", { status: session.status });
            } else {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            }

            if (TERMINAL.has(session.status)) close();
          } catch {
            /* transient db error; keep streaming */
          }
        };
        const timer = setInterval(() => void poll().catch(close), pollMs);
        void poll();
        request.signal.addEventListener("abort", close, { once: true });
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
  };
}
