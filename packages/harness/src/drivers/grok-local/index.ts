import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { createLocalAgentAdapter, standardLocalArgs } from "../../shared/local-agent.js";

export const grokLocal: ServerAdapterModule = createLocalAgentAdapter({
  info: {
    type: "grok_local",
    label: "Grok Build",
    transport: "local_subprocess",
    models: [{ id: "grok-build", label: "Grok Build" }],
    agentConfigurationDoc: `# grok_local

Runs Grok Build in single-run streaming JSON mode with resumable sessions.
`,
    status: "ready",
  },
  command: "grok",
  promptMode: "stdin",
  resumeFlag: "--resume",
  buildArgs: (config, ctx) => [
    "--single",
    "--output-format",
    "streaming-json",
    ...standardLocalArgs(config, ctx, {
      resumeFlag: "--resume",
      modelFlag: "--model",
    }),
  ],
});

export const module: ServerAdapterModule = grokLocal;
