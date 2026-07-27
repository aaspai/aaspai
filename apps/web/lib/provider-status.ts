import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAdapter, listAdapters } from "@aaspai/harness";
import { workspaceRoot } from "@/lib/aaspai";

export const frontendProviderTypes = [
  "codex_local",
  "claude_local",
  "opencode_cli",
  "dry_run_local",
] as const;

export type FrontendProvider = (typeof frontendProviderTypes)[number];

export async function listFrontendProviderModels(type: FrontendProvider) {
  const fallback = listAdapters().find((adapter) => adapter.type === type)?.models ?? [];
  if (type !== "codex_local") return fallback;
  try {
    const cache = JSON.parse(
      await readFile(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json"),
        "utf8",
      ),
    ) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };
    const models = (cache.models ?? [])
      .filter(
        (model) =>
          typeof model.slug === "string" &&
          typeof model.display_name === "string" &&
          model.visibility !== "hide",
      )
      .map((model) => ({ id: model.slug as string, label: model.display_name as string }));
    return models.length > 0 ? models : fallback;
  } catch {
    return fallback;
  }
}

export async function listFrontendProviders() {
  const adapters = listAdapters();
  return Promise.all(
    frontendProviderTypes.map(async (type) => {
      const info = adapters.find((adapter) => adapter.type === type);
      const models = await listFrontendProviderModels(type);
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
        models,
        installed,
        ready: type === "dry_run_local" || environment.ok,
        environment,
      };
    }),
  );
}
