import { NextResponse } from "next/server";
import { isAaspaiWorkspace } from "@/lib/aaspai";
import { deleteConversation, getConversationDetail } from "@/lib/conversations";
import { currentUser } from "@/lib/local-auth";

export const dynamic = "force-dynamic";

/** `GET /api/inbox/conversations/[id]` — full transcript + resume info. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const { id } = await params;
  const rootId = decodeURIComponent(id);
  const conversation = await getConversationDetail(user.organizationId, rootId);
  if (!conversation) {
    return NextResponse.json({ error: `conversation ${rootId} not found` }, { status: 404 });
  }
  return NextResponse.json(conversation);
}

/** `DELETE /api/inbox/conversations/[id]` — remove the thread (org-scoped). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const { id } = await params;
  const rootId = decodeURIComponent(id);
  const deleted = await deleteConversation(user.organizationId, rootId);
  if (!deleted) {
    return NextResponse.json({ error: `conversation ${rootId} not found` }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
