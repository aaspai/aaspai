import { getDefaultDb, sessions as sessionsTable } from "@aaspai/db";
import { Sessions } from "@aaspai/sessions";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureWorkspaceEnv, isAaspaiWorkspace } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

const bodySchema = z.object({
  answer: z.string().min(1).max(8_192),
});

export const dynamic = "force-dynamic";

/**
 * Answer a session's pending question (Phase 3b). Resolves the parked
 * `onQuestion` promise so the running adapter can continue, records
 * the answer as a user-kind session event, and flips the session back
 * to `running`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const sessionId = decodeURIComponent((await params).id);
  ensureWorkspaceEnv();

  const handle = getDefaultDb();
  const [row] = await handle.db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId))
    .limit(1);
  if (!row || row.organizationId !== user.organizationId) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  if (row.status !== "paused_for_question") {
    return NextResponse.json({ error: "session is not waiting for an answer" }, { status: 409 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json({ error: "invalid request", details: String(err) }, { status: 400 });
  }

  const sessions = new Sessions({
    agentSource: { get: async () => null } as never,
    knowledgeSource: { get: async () => null } as never,
    skillRegistry: undefined as never,
  });

  await sessions.resume(sessionId, body.answer);

  return NextResponse.json({ sessionId, status: "running" });
}
