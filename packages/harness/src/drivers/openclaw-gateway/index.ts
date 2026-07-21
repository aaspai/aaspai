import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";

export const openclawGatewayInfo = {
  type: "openclaw_gateway" as const,
  label: "OpenClaw Gateway",
  transport: "gateway" as const,
  models: [{ id: "default", label: "Default" }],
  agentConfigurationDoc:
    "# openclaw_gateway\n\nStub. Real impl pending (WebSocket JSON-frame protocol with Ed25519 device pairing).",
  status: "stub" as const,
};

const STUB_MESSAGE =
  "openclaw_gateway is a stub in @aaspai/harness. Wire it up when you need it (WebSocket + JSON frame protocol).";

export const openclawGateway: ServerAdapterModule = {
  info: openclawGatewayInfo,
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

export const module: ServerAdapterModule = openclawGateway;
