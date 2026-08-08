import { ensureWorkspaceEnv } from "@/lib/aaspai";

/**
 * Catalog of environment variables the dashboard can manage, grouped by
 * provider — the Hermes Env-page model. Keys NOT in the catalog are
 * still readable/writable as "custom" keys, but we only *document* the
 * ones the product actually consumes.
 *
 * Secrets live in the workspace `.env.local` (never committed). The API
 * returns a redacted preview; full values are fetched only on an
 * explicit reveal call.
 */

export interface EnvVarInfo {
  /** Category drives the top-level grouping. */
  category: "provider" | "setting";
  /** Provider display name (drives grouping when set). */
  provider?: string;
  description: string;
  url?: string;
  /** Mirrored secret (`.env` values are always written verbatim). */
  password: boolean;
  /** True when this key came from the user (not the catalog). */
  custom?: boolean;
}

export const KEY_CATALOG: Record<string, EnvVarInfo> = {
  DAYTONA_API_KEY: {
    category: "provider",
    provider: "Daytona",
    description: "API key for Daytona sandbox provisioning.",
    url: "https://app.daytona.io",
    password: true,
  },
  DAYTONA_SNAPSHOT: {
    category: "provider",
    provider: "Daytona",
    description: "Snapshot id for the default Daytona sandbox template.",
    password: false,
  },
  OPENCODE_GO_API_KEY: {
    category: "provider",
    provider: "OpenCode Go",
    description: "API key for the OpenCode Go provider (agent adapters).",
    password: true,
  },
  OPENCODE_ANTHROPIC_API_KEY: {
    category: "provider",
    provider: "Anthropic",
    description: "Anthropic API key used by the OpenCode CLI provider.",
    url: "https://console.anthropic.com",
    password: true,
  },
  OPENAI_API_KEY: {
    category: "provider",
    provider: "OpenAI",
    description: "OpenAI API key for model access.",
    url: "https://platform.openai.com",
    password: true,
  },
  DEEPSEEK_API_KEY: {
    category: "provider",
    provider: "DeepSeek",
    description: "DeepSeek API key.",
    password: true,
  },
};

/** Provider priority: lower renders first (Hermes ordering). */
export const PROVIDER_PRIORITY: Record<string, number> = {
  Daytona: 0,
  "OpenCode Go": 1,
  Anthropic: 2,
  OpenAI: 3,
  DeepSeek: 4,
};

export function providerPriority(name: string): number {
  return PROVIDER_PRIORITY[name] ?? 99;
}

/** A known key → group name; falls back to "Other". */
export function providerGroupName(key: string): string {
  const info = KEY_CATALOG[key];
  return info?.provider ?? "Other";
}

export function isCatalogKey(key: string): boolean {
  return key in KEY_CATALOG;
}

/** Redact a value to a short preview (`abcd…wxyz`). */
export function redact(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function ensureWorkspaceEnvForCatalog(): void {
  ensureWorkspaceEnv();
}
