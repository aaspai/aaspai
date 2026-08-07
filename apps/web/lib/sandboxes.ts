import { getDefaultDb, runMigrations } from "@aaspai/db";
import { SandboxManager, type SandboxSummary } from "@aaspai/runtime";
import { ensureWorkspaceEnv, isAaspaiWorkspace } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

/**
 * Web-side sandbox registry access. Exposes the live sandbox state for
 * the frontend ("agents up", per-session sandboxes, TTL status).
 *
 * Pages are server components without a direct org param, so the helper
 * resolves the current user's org from the session cookie (same as the
 * API routes, which pass the org explicitly).
 */

export type { SandboxSummary };

const manager = () => new SandboxManager();

async function ready(): Promise<string | null> {
  ensureWorkspaceEnv();
  if (!isAaspaiWorkspace()) return null;
  runMigrations(getDefaultDb());
  const user = await currentUser();
  return user?.organizationId ?? "default";
}

export async function listSandboxes(): Promise<SandboxSummary[]> {
  const org = await ready();
  if (!org) return [];
  return manager().list(org);
}

export async function listLiveSandboxes(): Promise<SandboxSummary[]> {
  const org = await ready();
  if (!org) return [];
  return manager().listLive(org);
}

export async function isAgentUp(agentId: string): Promise<boolean> {
  const org = await ready();
  if (!org) return false;
  return manager().isAgentUp(org, agentId);
}

export async function destroySandbox(sandboxId: string): Promise<void> {
  const org = await ready();
  if (!org) return;
  const rows = await manager().list(org);
  // Scope by org: never destroy a sandbox that belongs to another org.
  const owned = rows.some((sandbox) => sandbox.id === sandboxId);
  if (!owned) return;
  await manager().destroy(sandboxId);
}
