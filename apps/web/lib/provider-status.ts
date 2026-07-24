import { getAdapter, listAdapters } from "@aaspai/harness";
import { workspaceRoot } from "@/lib/aaspai";

export const frontendProviderTypes = [
  "codex_local",
  "claude_local",
  "opencode_cli",
  "dry_run_local",
] as const;

export type FrontendProvider = (typeof frontendProviderTypes)[number];

export async function listFrontendProviders() {
  const adapters = listAdapters();
  return Promise.all(
    frontendProviderTypes.map(async (type) => {
      const info = adapters.find((adapter) => adapter.type === type);
      const environment = await getAdapter(type).testEnvironment({
        config: {},
        cwd: workspaceRoot(),
      });
      const installed =
        type === "dry_run_local" ||
        !environment.checks.some(
          (check) => check.name.endsWith("_cli") && /not found|enoent/i.test(check.message),
        );
      return {
        type,
        label: info?.label ?? type,
        installed,
        ready: type === "dry_run_local" || environment.ok,
        environment,
      };
    }),
  );
}
