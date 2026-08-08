/**
 * Runtime V2 deliberately keeps lease state out of the web process. Daytona
 * leases belong to the execution worker and are represented by serialized
 * runtime leases, not a web-owned provider registry.
 *
 * These read-only helpers remain as a narrow UI boundary until the web app is
 * migrated to query execution snapshots. They never create, resume, or
 * destroy provider resources.
 */
export interface SandboxSummary {
  id: string;
  organizationId: string;
  agentId: string;
  adapter: string;
  provider: string;
  status: "alive" | "ready" | "hibernating" | "archived" | "provisioning" | "failed" | "deleted";
  sessionId?: string;
  lastActiveAt?: string;
}

export async function listSandboxes(): Promise<SandboxSummary[]> {
  return [];
}

export async function listLiveSandboxes(): Promise<SandboxSummary[]> {
  return [];
}

export async function isAgentUp(_agentId: string): Promise<boolean> {
  return false;
}

export async function destroySandbox(_sandboxId: string): Promise<never> {
  throw new Error("Sandbox lifecycle is owned by Runtime V2 execution leases");
}
