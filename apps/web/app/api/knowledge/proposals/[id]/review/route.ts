import { knowledgeReviewInputSchema } from "@aaspai/contracts/knowledge";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { createKnowledgeCurator } from "@aaspai/knowledge";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv, isAaspaiWorkspace } from "@/lib/aaspai";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    ensureWorkspaceEnv();
    if (!isAaspaiWorkspace())
      return NextResponse.json({ error: "No aaspai workspace" }, { status: 404 });
    const body = (await request.json()) as Record<string, unknown>;
    const { id } = await params;
    const input = knowledgeReviewInputSchema.parse({ ...body, proposalId: id });
    const handle = getDefaultDb();
    runMigrations(handle);
    const result = await createKnowledgeCurator(handle.db).reviewProposal(input);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Knowledge review failed" },
      { status: 400 },
    );
  }
}
