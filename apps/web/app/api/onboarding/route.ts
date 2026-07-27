import { getAdapter } from "@aaspai/harness";
import { NextResponse } from "next/server";
import { z } from "zod";
import { workspaceRoot } from "@/lib/aaspai";
import { createFrontendGoal } from "@/lib/company-goals";
import { currentUser } from "@/lib/local-auth";
import { listFrontendProviderModels } from "@/lib/provider-status";
import { ensureFrontendWorkspace } from "@/lib/workspace-bootstrap";

const bodySchema = z.object({
  provider: z.enum(["codex_local", "claude_local", "opencode_cli", "dry_run_local"]),
  model: z.string().trim().min(1).max(256),
  ceoAgenda: z.string().trim().min(10).max(10_000),
  ceoInstructions: z.string().trim().min(10).max(10_000),
  goalTitle: z.string().trim().min(3).max(300),
  goalOutcome: z.string().trim().min(3).max(10_000),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
});

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Complete the company setup before continuing" },
      { status: 400 },
    );
  }

  const provider = getAdapter(parsed.data.provider);
  const models = await listFrontendProviderModels(parsed.data.provider);
  if (!models.some((model) => model.id === parsed.data.model)) {
    return NextResponse.json(
      { error: `${parsed.data.model} is not supported by ${provider.info.label}.` },
      { status: 400 },
    );
  }
  const environment = await provider.testEnvironment({
    config: { model: parsed.data.model },
    cwd: workspaceRoot(),
  });
  if (parsed.data.provider !== "dry_run_local" && !environment.ok) {
    return NextResponse.json(
      { error: `${parsed.data.provider} is not ready. Connect it on the setup page first.` },
      { status: 400 },
    );
  }

  await ensureFrontendWorkspace(user.companyName, {
    ceoProvider: parsed.data.provider,
    ceoModel: parsed.data.model,
    ceoAgenda: parsed.data.ceoAgenda,
    ceoInstructions: parsed.data.ceoInstructions,
  });
  const result = await createFrontendGoal({
    organizationId: user.organizationId,
    companyName: user.companyName,
    title: parsed.data.goalTitle,
    description: parsed.data.goalOutcome,
    projectTitle: `${parsed.data.goalTitle} delivery`,
    steps: parsed.data.steps,
  });
  return NextResponse.json({ data: result }, { status: 201 });
}
