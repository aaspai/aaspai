import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceRoot } from "@/lib/aaspai";
import { atomicWriteFile } from "@/lib/atomic-write";

/**
 * Read/write the workspace `.env.local` file (secrets only — API keys,
 * tokens). Mirrors the Hermes Env-page contract: keys are stored with
 * their raw value on disk, but the API never returns the full value to
 * the browser — only a redacted preview, with an explicit reveal call.
 */

export const ENV_FILE_NAME = ".env.local";

function envPath(): string {
  return join(workspaceRoot(), ENV_FILE_NAME);
}

export interface EnvEntry {
  key: string;
  value: string;
}

/** Parse `.env` content into entries, preserving nothing but key/value. */
export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      entries.push({ key, value });
    }
  }
  return entries;
}

function quote(value: string): string {
  if (!/[ \t"']/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Serialize entries back to `.env` content. Existing comments and
 * ordering are lost (simplest safe transform for a secrets file).
 */
export function serializeEnvFile(entries: EnvEntry[]): string {
  return `${entries.map((e) => `${e.key}=${quote(e.value)}`).join("\n")}\n`;
}

export async function readEnvFile(): Promise<EnvEntry[]> {
  try {
    return parseEnvFile(await readFile(envPath(), "utf8"));
  } catch {
    return [];
  }
}

export async function getEnvValue(key: string): Promise<string | null> {
  const entries = await readEnvFile();
  return entries.find((e) => e.key === key)?.value ?? null;
}

export async function writeEnvFile(entries: EnvEntry[]): Promise<void> {
  await atomicWriteFile(envPath(), serializeEnvFile(entries));
}

/** Set a key, replacing any existing value; preserves other keys. */
export async function setEnvValue(key: string, value: string): Promise<void> {
  const entries = await readEnvFile();
  const next = entries.filter((e) => e.key !== key);
  next.push({ key, value });
  await writeEnvFile(next);
}

/** Remove a key entirely. */
export async function clearEnvValue(key: string): Promise<void> {
  const entries = await readEnvFile();
  await writeEnvFile(entries.filter((e) => e.key !== key));
}
