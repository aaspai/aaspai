import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";

export const cursorCloudInfo = {
  type: "cursor_cloud" as const,
  label: "Cursor Cloud",
  transport: "cloud_sdk" as const,
  models: [
    { id: "auto", label: "Auto" },
    { id: "sonnet", label: "Claude Sonnet" },
    { id: "opus", label: "Claude Opus" },
  ],
  agentConfigurationDoc:
    "# cursor_cloud\n\nStub. Real impl pending (HTTPS SDK + Agent.create/Agent.resume).",
  status: "stub" as const,
};

const STUB_MESSAGE =
  "cursor_cloud is a stub in @aaspai/harness. Wire it up when you need it (uses @cursor/sdk; no subprocess).";

export const cursorCloud: ServerAdapterModule = {
  info: cursorCloudInfo,
  execute: async () => ({
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: 1,
    timedOut: false,
    errorMessage: STUB_MESSAGE,
    errorFamily: "internal" as const,
    summary: "stub",
    usageBasis: "per_run" as const,
    clearSession: false,
  }),
  testEnvironment: async () => ({
    ok: false,
    checks: [
      {
        name: "stub",
        level: "warn" as const,
        message: STUB_MESSAGE,
      },
    ],
  }),
};

export const module: ServerAdapterModule = cursorCloud;
