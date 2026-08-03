import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { createLocalAgentAdapter, standardLocalArgs } from "../../shared/local-agent.js";

export const piLocal: ServerAdapterModule = createLocalAgentAdapter({
  info: {
    type: "pi_local",
    label: "Pi",
    transport: "local_subprocess",
    models: [],
    agentConfigurationDoc: `# pi_local

Runs Pi with explicit model routing, prompt mode, and session resume support.
`,
    status: "ready",
  },
  command: "pi",
  promptMode: "argument",
  promptFlag: "-p",
  resumeFlag: "--session",
  buildArgs: (config, ctx) => [
    ...standardLocalArgs(config, ctx, {
      resumeFlag: "--session",
      modelFlag: "--model",
    }),
  ],
});

export const module: ServerAdapterModule = piLocal;
