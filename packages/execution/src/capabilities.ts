import type { ExecutionPlan } from "@aaspai/contracts/execution";
import { adapterTypeSchema } from "@aaspai/contracts/harness";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import { getAdapterCapabilities } from "@aaspai/harness";
import { getRuntimeTargetCapabilities } from "@aaspai/runtime";

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
  if (!getAdapterCapabilities(parsed.data).execute) {
    throw new ProviderCapabilityError(harness, "execute");
  }
}

export function assertExecutionPlanCapabilities(
  plan: Pick<ExecutionPlan, "harness" | "target">,
): void {
  assertHarnessExecutable(plan.harness);
  if (!getRuntimeTargetCapabilities(plan.target).execute) {
    throw new ProviderCapabilityError(
      plan.target.kind === "sandbox"
        ? `${plan.target.kind}:${plan.target.provider}`
        : plan.target.kind,
      "execute",
    );
  }
}

export function assertRuntimeExecutable(target: ExecutionTarget): void {
  if (!getRuntimeTargetCapabilities(target).execute) {
    throw new ProviderCapabilityError(
      target.kind === "sandbox" ? `${target.kind}:${target.provider}` : target.kind,
      "execute",
    );
  }
}
