import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";

export const hermesGatewayInfo = {
  type: "hermes_gateway" as const,
  label: "Hermes Gateway",
  transport: "gateway" as const,
  models: [{ id: "default", label: "Default" }],
  agentConfigurationDoc:
    "# hermes_gateway\n\nStub. Real impl pending (HTTP/SSE against a Hermes API server).",
  status: "stub" as const,
};

const STUB_MESSAGE =
  "hermes_gateway is a stub in @aaspai/harness. Wire it up when you need it (HTTP/SSE against a Hermes API).";

export const hermesGateway: ServerAdapterModule = {
  info: hermesGatewayInfo,
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

export const module: ServerAdapterModule = hermesGateway;
