import { CompanyCommandService } from "@aaspai/company";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { getAdapter } from "@aaspai/harness";
import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/local-auth";
import {
  frontendRuntimeTypes,
  listFrontendProviderModels,
  listFrontendRuntimes,
} from "@/lib/provider-status";
import { ensureFrontendWorkspace } from "@/lib/workspace-bootstrap";

const bodySchema = z.object({
  provider: z.literal("opencode_cli"),
  runtime: z.enum(frontendRuntimeTypes),
  model: z.string().trim().min(1).max(256),
  ceoAgenda: z.string().trim().min(10).max(10_000),
  ceoInstructions: z.string().trim().min(10).max(10_000),
  objectives: z
    .array(
      z.object({
        title: z.string().trim().min(3).max(300),
        outcome: z.string().trim().min(3).max(10_000),
      }),
    )
    .min(1)
    .max(4),
  firstPriority: z.string().trim().min(3).max(500),
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
  const runtime = (await listFrontendRuntimes()).find(
    (candidate) => candidate.type === parsed.data.runtime,
  );
  if (!runtime?.ready) {
    return NextResponse.json(
      {
        error: `${runtime?.label ?? parsed.data.runtime} is not ready: ${
          runtime?.checks
            .filter((check) => !check.ready)
            .map((check) => check.message)
            .join("; ") ?? "runtime unavailable"
        }.`,
      },
      { status: 503 },
    );
  }
  const models = await listFrontendProviderModels(parsed.data.provider);
  if (!models.some((model) => model.id === parsed.data.model)) {
    return NextResponse.json(
      { error: `${parsed.data.model} is not supported by ${provider.info.label}.` },
      { status: 400 },
    );
  }
  if (provider.info.status !== "ready") {
    return NextResponse.json(
      { error: `${parsed.data.provider} is not available in this build.` },
      { status: 400 },
    );
  }

  await ensureFrontendWorkspace(user.companyName, {
    ceoProvider: parsed.data.provider,
    ceoModel: parsed.data.model,
    ceoAgenda: parsed.data.ceoAgenda,
    ceoInstructions: parsed.data.ceoInstructions,
    runtime: runtime.target,
  });
  const db = getDefaultDb();
  runMigrations(db);
  const commands = new CompanyCommandService(db.db);
  const setup = await commands.execute({
    type: "setup_company",
    organizationId: user.organizationId,
    actorId: user.id,
    idempotencyKey: `onboarding:${user.organizationId}`,
    description: parsed.data.ceoAgenda,
    timezone: "UTC",
    ceoAgentId: "agent/ceo",
    operatorAgentId: "agent/operator",
    policy: {
      provider: parsed.data.provider,
      model: parsed.data.model,
      runtime: runtime.target,
      firstPriority: parsed.data.firstPriority,
      founderApprovalRequiredForPortfolio: true,
      externalActions: "approval_required",
    },
    objectives: parsed.data.objectives.map((objective, index) => ({
      title: objective.title,
      description: objective.outcome,
      successCriteria: [objective.outcome],
      priority: 100 - index * 10,
    })),
  });
  await commands.execute({
    type: "validate_company",
    organizationId: user.organizationId,
    actorId: user.id,
    idempotencyKey: `onboarding-validate:${user.organizationId}`,
  });
  await commands.execute({
    type: "start_discovery",
    organizationId: user.organizationId,
    actorId: user.id,
    idempotencyKey: `onboarding-discovery:${user.organizationId}`,
  });
  return NextResponse.json(
    { data: { ...setup, status: "discovery", firstPriority: parsed.data.firstPriority } },
    { status: 201 },
  );
}
