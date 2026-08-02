import { ProcessImprovementService } from "@aaspai/company";
import { type KnowledgeReviewInput, knowledgeReviewInputSchema } from "@aaspai/contracts/knowledge";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv, isAaspaiWorkspace } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

interface ReviewRouteDependencies {
  getUser: () => Promise<{ id: string; organizationId: string } | null>;
  ensureWorkspace: () => void;
  isWorkspace: () => boolean;
  review: (input: KnowledgeReviewInput) => Promise<unknown>;
}

const defaultDependencies: ReviewRouteDependencies = {
  getUser: currentUser,
  ensureWorkspace: ensureWorkspaceEnv,
  isWorkspace: isAaspaiWorkspace,
  review: async (input) => {
    const handle = getDefaultDb();
    runMigrations(handle);
    return new ProcessImprovementService(handle.db).review(input);
  },
};

export function createKnowledgeReviewPost(
  overrides: Partial<ReviewRouteDependencies> = {},
): (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (request, { params }) => {
    const user = await dependencies.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    try {
      dependencies.ensureWorkspace();
      if (!dependencies.isWorkspace())
        return NextResponse.json({ error: "No aaspai workspace" }, { status: 404 });
      const body = (await request.json()) as Record<string, unknown>;
      const { id } = await params;
      const input = knowledgeReviewInputSchema.parse({
        ...body,
        organizationId: user.organizationId,
        proposalId: id,
        actorId: user.id,
      });
      return NextResponse.json(await dependencies.review(input));
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Knowledge review failed" },
        { status: 400 },
      );
    }
  };
}

export const POST = createKnowledgeReviewPost();
