import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import { getAdapter, listAdapters } from "@aaspai/harness";
import { Daytona } from "@daytonaio/sdk";
import { workspaceRoot } from "@/lib/aaspai";

const execFileAsync = promisify(execFile);
const defaultGatewayModel = "poolside/laguna-s-2.1:free";
const defaultDockerImage = "aaspai-opencode-test:latest";

export const frontendProviderTypes = [
  "codex_local",
  "claude_local",
  "opencode_cli",
  "dry_run_local",
] as const;

export type FrontendProvider = (typeof frontendProviderTypes)[number];

export const frontendRuntimeTypes = ["daytona", "docker"] as const;
export type FrontendRuntime = (typeof frontendRuntimeTypes)[number];

export async function listFrontendProviderModels(type: FrontendProvider) {
  const fallback = listAdapters().find((adapter) => adapter.type === type)?.models ?? [];
  if (type === "opencode_cli") {
    const upstream = process.env.AASPAI_GATEWAY_MODEL?.trim() || defaultGatewayModel;
    return [{ id: `aaspai/${upstream}`, label: `${upstream} through the governed gateway` }];
  }
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

export function frontendRuntimeTarget(type: FrontendRuntime): ExecutionTarget {
  return type === "docker"
    ? {
        kind: "docker",
        image: process.env.AASPAI_DOCKER_IMAGE?.trim() || defaultDockerImage,
        remoteCwd: "/workspace",
        network: "bridge",
      }
    : {
        kind: "sandbox",
        provider: "daytona",
        remoteCwd: "/workspace",
        timeoutMs: 300_000,
      };
}

export async function listFrontendRuntimes() {
  const gatewayUrl = process.env.AASPAI_GATEWAY_CONTROL_URL?.replace(/\/+$/, "");
  const gatewayConfigured = Boolean(
    gatewayUrl &&
      process.env.AASPAI_GATEWAY_CONTROL_TOKEN &&
      process.env.AASPAI_GATEWAY_AGENT_BASE_URL,
  );
  const gatewayReady =
    gatewayConfigured &&
    Boolean(
      await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(5_000) })
        .then((response) => response.ok)
        .catch(() => false),
    );
  const daytonaReady = process.env.DAYTONA_API_KEY
    ? await new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
        .list(undefined, 1, 1)
        .then(() => true)
        .catch(() => false)
    : false;
  const dockerReady = await execFileAsync(
    "docker",
    ["image", "inspect", process.env.AASPAI_DOCKER_IMAGE?.trim() || defaultDockerImage],
    { windowsHide: true, timeout: 5_000 },
  )
    .then(() => true)
    .catch(() => false);
  return [
    {
      type: "daytona" as const,
      label: "Daytona cloud sandbox",
      ready: daytonaReady && gatewayReady,
      target: frontendRuntimeTarget("daytona"),
      checks: [
        {
          ready: daytonaReady,
          message: daytonaReady
            ? "Daytona credential accepted"
            : "DAYTONA_API_KEY is missing or invalid",
        },
        {
          ready: gatewayReady,
          message: gatewayReady
            ? "Attempt-credential gateway is healthy"
            : "Attempt-credential gateway is unavailable",
        },
      ],
    },
    {
      type: "docker" as const,
      label: "Local Docker sandbox",
      ready: dockerReady && gatewayReady,
      target: frontendRuntimeTarget("docker"),
      checks: [
        {
          ready: dockerReady,
          message: dockerReady
            ? "Isolated OpenCode image is available"
            : `Docker image ${process.env.AASPAI_DOCKER_IMAGE?.trim() || defaultDockerImage} is unavailable`,
        },
        {
          ready: gatewayReady,
          message: gatewayReady
            ? "Attempt-credential gateway is healthy"
            : "Attempt-credential gateway is unavailable",
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
