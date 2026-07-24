import { NextResponse } from "next/server";
import { createFrontendGoal } from "@/lib/company-goals";
import { currentUser } from "@/lib/local-auth";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const steps = Array.isArray(body?.steps)
    ? body.steps.filter(
        (step): step is string => typeof step === "string" && step.trim().length > 0,
      )
    : [];
  if (typeof body?.title !== "string" || !body.title.trim() || steps.length === 0) {
    return NextResponse.json(
      { error: "A goal title and at least one pipeline step are required" },
      { status: 400 },
    );
  }
  const result = await createFrontendGoal({
    organizationId: user.organizationId,
    companyName: user.companyName,
    title: body.title.trim(),
    description: typeof body.description === "string" ? body.description : undefined,
    projectTitle: typeof body.projectTitle === "string" ? body.projectTitle : undefined,
    steps,
  });
  return NextResponse.json({ data: result }, { status: 201 });
}
