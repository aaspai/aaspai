import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import { getAdapter, listAdapters } from "@aaspai/harness";
import { workspaceRoot } from "@/lib/aaspai";

export const frontendProviderTypes = ["codex_local", "opencode_cli"] as const;

export type FrontendProvider = (typeof frontendProviderTypes)[number];

export const frontendRuntimeTypes = ["local"] as const;
export type FrontendRuntime = (typeof frontendRuntimeTypes)[number];

async function codexModels() {
  const fallback = listAdapters().find((adapter) => adapter.type === "codex_local")?.models ?? [];
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

export function frontendRuntimeTarget(type: FrontendRuntime): ExecutionTarget {
  void type;
  return { kind: "local", envPassthrough: false };
}

export async function listFrontendRuntimes() {
  return [
    {
      type: "local" as const,
      label: "Authenticated local CLI session",
      ready: true,
      target: frontendRuntimeTarget("local"),
      checks: [
        {
          ready: true,
          message: "Uses the CLI's existing login and native resumable sessions",
        },
      ],
    },
  ];
}

export async function listFrontendProviders() {
  const adapters = listAdapters();
  return Promise.all(
    frontendProviderTypes.map(async (type) => {
      const info = adapters.find((adapter) => adapter.type === type);
      const environment = await getAdapter(type).testEnvironment({
        config: {},
        cwd: workspaceRoot(),
      });
      const discovered =
        type === "opencode_cli"
          ? environment.checks.flatMap((check) =>
              Array.isArray(check.details?.models)
                ? check.details.models.filter((model): model is string => typeof model === "string")
                : [],
            )
          : [];
      const models =
        type === "codex_local"
          ? await codexModels()
          : discovered.length > 0
            ? discovered.map((model) => ({ id: model, label: model }))
            : (info?.models ?? []);
      const installed = !environment.checks.some(
        (check) => check.name.endsWith("_cli") && /not found|enoent/i.test(check.message),
      );
      return {
        type,
        label: info?.label ?? type,
        models,
        installed,
        ready: environment.ok,
        environment,
      };
    }),
  );
}
