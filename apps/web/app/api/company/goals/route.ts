import { NextResponse } from "next/server";
import { createFrontendGoal } from "@/lib/company-goals";
import { currentUser } from "@/lib/local-auth";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    typeof body?.title !== "string" ||
    !body.title.trim() ||
    typeof body.mandate !== "string" ||
    !body.mandate.trim()
  ) {
    return NextResponse.json(
      { error: "An objective and direction for the CEO are required" },
      { status: 400 },
    );
  }
  const result = await createFrontendGoal({
    organizationId: user.organizationId,
    companyName: user.companyName,
    title: body.title.trim(),
    description: typeof body.description === "string" ? body.description : undefined,
    projectTitle: typeof body.projectTitle === "string" ? body.projectTitle : undefined,
    mandate: body.mandate,
    requestedByActorId: user.id,
  });
  return NextResponse.json({ data: result }, { status: 201 });
}
