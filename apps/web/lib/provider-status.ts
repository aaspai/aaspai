import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import { getProductionAdapter, listProductionAdapters } from "@aaspai/harness";
import { workspaceRoot } from "@/lib/aaspai";

export const frontendProviderTypes = ["opencode_local"] as const;
export type FrontendProvider = (typeof frontendProviderTypes)[number];

export const frontendRuntimeTypes = ["local"] as const;
export type FrontendRuntime = (typeof frontendRuntimeTypes)[number];

const defaultOpencodeModel = { id: "opencode/big-pickle", label: "Big Pickle" };

export function filterOpencodeModels(
  models: string[],
  _authenticatedProviders: Iterable<string> = [],
) {
  const allowed = models.filter((model) => model.includes("/"));
  return [defaultOpencodeModel.id, ...allowed]
    .filter((model, index, all) => all.indexOf(model) === index)
    .map((model) =>
      model === defaultOpencodeModel.id ? defaultOpencodeModel : { id: model, label: model },
    );
}

/** Retained as a pure UI helper; auth files are no longer read by the foundation. */
export function configuredOpencodeProviders(auth: unknown) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return [];
  return Object.entries(auth)
    .filter(
      ([provider, value]) =>
        provider.trim().length > 0 &&
        value !== null &&
        typeof value === "object" &&
        Object.keys(value).length > 0,
    )
    .map(([provider]) => provider);
}

export function frontendRuntimeTarget(_type: FrontendRuntime): ExecutionTarget {
  return { kind: "local", envPassthrough: false };
}

export async function listFrontendRuntimes() {
  return [
    {
      type: "local" as const,
      label: "Managed local runtime",
      ready: true,
      target: frontendRuntimeTarget("local"),
      checks: [{ ready: true, message: "Commands run through Runtime V2 Local." }],
    },
  ];
}

export async function listFrontendProviders() {
  const adapters = listProductionAdapters();
  return Promise.all(
    frontendProviderTypes.map(async (type) => {
      const info = adapters.find((adapter) => adapter.type === type);
      const environment = await getProductionAdapter(type).testEnvironment({
        config: {
          ...(process.env.OPENCODE_SERVER_URL
            ? { serverUrl: process.env.OPENCODE_SERVER_URL }
            : {}),
        },
        cwd: workspaceRoot(),
      });
      const discovered = environment.checks.flatMap((check) =>
        Array.isArray(check.details?.models)
          ? check.details.models.filter((model): model is string => typeof model === "string")
          : [],
      );
      return {
        type,
        label: info?.label ?? type,
        models: filterOpencodeModels(discovered),
        installed: true,
        ready: environment.ok,
        environment,
      };
    }),
  );
}
