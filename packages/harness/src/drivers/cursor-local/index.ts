import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";

export const cursorLocalInfo = {
  type: "cursor_local" as const,
  label: "Cursor (local)",
  transport: "local_subprocess" as const,
  models: [
    { id: "auto", label: "Auto" },
    { id: "sonnet", label: "Claude Sonnet" },
    { id: "opus", label: "Claude Opus" },
  ],
  agentConfigurationDoc: "# cursor_local\n\nStub. Real impl pending.",
  status: "stub" as const,
};

const STUB_MESSAGE = "cursor_local is a stub in @aaspai/harness. Wire it up when you need it.";

export const cursorLocal: ServerAdapterModule = {
  info: cursorLocalInfo,
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

export const module: ServerAdapterModule = cursorLocal;
