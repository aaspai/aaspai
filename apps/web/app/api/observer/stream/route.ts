import { desc, eq, getDefaultDb, telemetryLogs } from "@aaspai/db";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return new Response("Authentication required", { status: 401 });
  ensureWorkspaceEnv();
  const handle = getDefaultDb();

  const encoder = new TextEncoder();
  let lastId = request.headers.get("last-event-id") ?? "";

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
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
      const poll = async () => {
        if (closed) return;
        try {
          const [latest] = await handle.db
            .select({ id: telemetryLogs.id })
            .from(telemetryLogs)
            .where(eq(telemetryLogs.organizationId, user.organizationId))
            .orderBy(desc(telemetryLogs.id))
            .limit(1);
          const current = latest?.id ?? "";
          if (current && current !== lastId) {
            lastId = current;
            controller.enqueue(
              encoder.encode(
                `id: ${current}\nevent: update\ndata: ${JSON.stringify({ lastId: current })}\n\n`,
              ),
            );
          } else {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
        } catch {
          /* transient db error; keep streaming */
        }
      };
      const timer = setInterval(poll, 1_500);
      void poll();
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
