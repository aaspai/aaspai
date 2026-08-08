import type { ExecutionPlan } from "@aaspai/contracts/execution";
import { adapterTypeSchema } from "@aaspai/contracts/harness";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import { getAdapterCapabilities } from "@aaspai/harness";

export class ProviderCapabilityError extends Error {
  readonly code = "provider_capability_unsupported" as const;
  constructor(
    public readonly provider: string,
    capability: string,
  ) {
    super(`Provider "${provider}" does not support required capability "${capability}"`);
    this.name = "ProviderCapabilityError";
  }
}

export function assertHarnessExecutable(harness: string): void {
  const parsed = adapterTypeSchema.safeParse(harness);
  if (!parsed.success) throw new ProviderCapabilityError(harness, "execute");
  try {
    if (!getAdapterCapabilities(parsed.data).execute) {
      throw new ProviderCapabilityError(harness, "execute");
    }
  } catch {
    throw new ProviderCapabilityError(harness, "execute");
  }
}

export function assertExecutionPlanCapabilities(
  plan: Pick<ExecutionPlan, "harness" | "target">,
): void {
  assertHarnessExecutable(plan.harness);
  assertRuntimeExecutable(plan.target);
}

export function assertRuntimeExecutable(target: ExecutionTarget): void {
  if (target.kind !== "local") {
    throw new ProviderCapabilityError(
      target.kind === "sandbox" ? `${target.kind}:${target.provider}` : target.kind,
      "Runtime V2 execution boundary",
    );
  }
}

export async function assertRuntimeReady(target: ExecutionTarget): Promise<void> {
  assertRuntimeExecutable(target);
}
