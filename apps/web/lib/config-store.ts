import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureWorkspaceEnv, workspaceRoot } from "@/lib/aaspai";
import { atomicWriteFile } from "@/lib/atomic-write";

/**
 * Read/write the workspace `aaspai.config.json`. The JSON config is the
 * canonical machine-level settings file (the web app runs in the same
 * workspace as the CLI, like Hermes). We keep unknown keys intact and
 * only write back the merged result so hand-authored config survives.
 */

export interface AaspaiConfig {
  database?: { url?: string };
  organization?: { id?: string; name?: string };
  agents?: { root?: string };
  knowledge?: { root?: string };
  loops?: { root?: string };
  runtime?: {
    sandbox?: {
      provider?: string;
      remoteCwd?: string;
      timeoutMs?: number;
    };
  };
  [key: string]: unknown;
}

/**
 * Declarative schema for the settings editor (Hermes ConfigPage
 * pattern). Mirrors the shape of `aaspai.config.json`.
 */
export const CONFIG_SCHEMA: ConfigSection[] = [
  {
    key: "organization",
    label: "Organization",
    description: "Company identity used by the CLI and web.",
    fields: [
      { key: "name", label: "Name", type: "string", description: "Company display name." },
      { key: "id", label: "ID", type: "string", description: "Organization id (stable key)." },
    ],
  },
  {
    key: "database",
    label: "Database",
    description: "SQLite store used for durable sessions and state.",
    fields: [
      { key: "url", label: "URL", type: "string", description: "sqlite: URL or file path." },
    ],
  },
  {
    key: "agents",
    label: "Agents",
    description: "Where agent definitions (AGENT.md files) live.",
    fields: [{ key: "root", label: "Root", type: "string" }],
  },
  {
    key: "knowledge",
    label: "Knowledge",
    description: "Where knowledge sources live.",
    fields: [{ key: "root", label: "Root", type: "string" }],
  },
  {
    key: "loops",
    label: "Loops",
    description: "Where loop definitions live.",
    fields: [{ key: "root", label: "Root", type: "string" }],
  },
  {
    key: "runtime",
    label: "Runtime",
    description: "Default sandbox execution settings for chat sessions.",
    fields: [
      {
        key: "sandbox",
        label: "Sandbox",
        type: "object",
        description: "Defaults applied when a chat runs on a cloud sandbox.",
      },
    ],
  },
];

export interface ConfigSection {
  key: string;
  label: string;
  description?: string;
  fields: ConfigFieldDef[];
}

export interface ConfigFieldDef {
  key: string;
  label: string;
  description?: string;
  type: "string" | "number" | "boolean" | "select" | "object";
  options?: string[];
  placeholder?: string;
}

/** Materialize the runtime field schema into leaf-level fields. */
export function runtimeSandboxFields(): ConfigFieldDef[] {
  return [
    {
      key: "provider",
      label: "Provider",
      type: "select",
      options: ["daytona"],
      description: "Sandbox provider for chat sessions.",
    },
    {
      key: "remoteCwd",
      label: "Remote CWD",
      type: "string",
      description: "Working directory inside the sandbox.",
    },
    {
      key: "timeoutMs",
      label: "Timeout (ms)",
      type: "number",
      description: "Session timeout in milliseconds.",
    },
  ];
}

function configPath(): string {
  return join(workspaceRoot(), ".aaspai", "aaspai.config.json");
}

export async function readConfig(): Promise<AaspaiConfig> {
  ensureWorkspaceEnv();
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as AaspaiConfig)
      : {};
  } catch {
    return {};
  }
}

export async function writeConfig(next: AaspaiConfig): Promise<void> {
  ensureWorkspaceEnv();
  const file = configPath();
  // Deep-merge with the existing file so concurrent writes don't clobber
  // unrelated sections (e.g. loops.root set by the CLI while the UI edits
  // organization.name).
  const existing = await readConfig();
  const merged = mergeDeep(existing, next);
  await atomicWriteFile(file, `${JSON.stringify(merged, null, 2)}\n`);
}

/** Deep-merge plain objects; arrays and scalars are replaced wholesale. */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (
    patch === null ||
    patch === undefined ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base)
  ) {
    return (patch ?? base) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = mergeDeep(out[key], value);
  }
  return out as T;
}
