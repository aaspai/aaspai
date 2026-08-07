import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import { getAdapter, listAdapters } from "@aaspai/harness";
import { workspaceRoot } from "@/lib/aaspai";

export const frontendProviderTypes = ["codex_local", "opencode_cli"] as const;

export type FrontendProvider = (typeof frontendProviderTypes)[number];

export const frontendRuntimeTypes = ["local", "sandbox:daytona"] as const;
export type FrontendRuntime = (typeof frontendRuntimeTypes)[number];

const defaultOpencodeModel = { id: "opencode/big-pickle", label: "Big Pickle" };

export function filterOpencodeModels(models: string[], authenticatedProviders: Iterable<string>) {
  const authenticated = new Set(
    [...authenticatedProviders].map((provider) => provider.trim().toLowerCase()),
  );
  const allowed = models.filter((model) => {
    const separator = model.indexOf("/");
    if (separator <= 0) return false;
    const provider = model.slice(0, separator).toLowerCase();
    return provider === "opencode" || authenticated.has(provider);
  });
  return [defaultOpencodeModel.id, ...allowed]
    .filter((model, index, all) => all.indexOf(model) === index)
    .map((model) =>
      model === defaultOpencodeModel.id ? defaultOpencodeModel : { id: model, label: model },
    );
}

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

async function authenticatedOpencodeProviders() {
  try {
    const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    const auth = JSON.parse(
      await readFile(
        process.env.OPENCODE_AUTH_PATH ?? join(dataHome, "opencode", "auth.json"),
        "utf8",
      ),
    ) as unknown;
    return configuredOpencodeProviders(auth);
  } catch {
    return [];
  }
}

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
  if (type === "sandbox:daytona") {
    return {
      kind: "sandbox",
      provider: "daytona",
      remoteCwd: "/workspace",
      timeoutMs: 240_000,
    };
  }
  return { kind: "local", envPassthrough: false };
}

export async function listFrontendRuntimes() {
  const daytonaReady = Boolean(process.env.DAYTONA_API_KEY?.trim());
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
    {
      type: "sandbox:daytona" as const,
      label: "Daytona sandbox",
      ready: daytonaReady,
      target: frontendRuntimeTarget("sandbox:daytona"),
      checks: [
        {
          ready: daytonaReady,
          message: daytonaReady
            ? "DAYTONA_API_KEY is configured"
            : "DAYTONA_API_KEY is not set — sandbox mode unavailable",
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
      const authenticatedProviders =
        type === "opencode_cli" ? await authenticatedOpencodeProviders() : [];
      const models =
        type === "codex_local"
          ? await codexModels()
          : filterOpencodeModels(discovered, authenticatedProviders);
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
