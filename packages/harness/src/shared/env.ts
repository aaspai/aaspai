import type { AdapterAgent } from "@aaspai/contracts/harness";

/**
 * Build the `AASPAI_*` env vars an agent receives on every run.
 *
 * These are the analog of paperclip's `PAPERCLIP_*` env injection
 * (`PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, …). Renamed for
 * aaspai, with the same role: every agent process can introspect
 * "which aaspai agent am I, on which org, on which run" without
 * taking a CLI flag.
 */
export function buildAgentEnv(
  agent: Pick<AdapterAgent, "id" | "organizationId" | "name" | "adapterType">,
  extras: {
    runId: string;
    sessionId?: string | undefined;
    sessionDisplayId?: string | undefined;
    cwd?: string | undefined;
    additionalEnv?: Record<string, string> | undefined;
  },
): Record<string, string> {
  const env: Record<string, string> = {
    AASPAI_AGENT_ID: agent.id,
    AASPAI_ORGANIZATION_ID: agent.organizationId,
    AASPAI_AGENT_NAME: agent.name,
    AASPAI_ADAPTER_TYPE: agent.adapterType,
    AASPAI_RUN_ID: extras.runId,
    ...(extras.sessionId !== undefined ? { AASPAI_SESSION_ID: extras.sessionId } : {}),
    ...(extras.sessionDisplayId !== undefined
      ? { AASPAI_SESSION_DISPLAY_ID: extras.sessionDisplayId }
      : {}),
    ...(extras.cwd !== undefined ? { AASPAI_CWD: extras.cwd } : {}),
    AASPAI_PROTOCOL_VERSION: "1",
  };
  if (extras.additionalEnv) {
    for (const [k, v] of Object.entries(extras.additionalEnv)) {
      env[k] = v;
    }
  }
  return env;
}
