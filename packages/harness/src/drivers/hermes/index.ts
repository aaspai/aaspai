import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { createLocalAgentAdapter, standardLocalArgs } from "../../shared/local-agent.js";

export const hermesLocal: ServerAdapterModule = createLocalAgentAdapter({
  info: {
    type: "hermes_local",
    label: "Hermes Agent",
    transport: "local_subprocess",
    models: [
      { id: "auto", label: "Auto" },
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet" },
    ],
    agentConfigurationDoc: `# hermes_local

Runs the Hermes CLI in quiet, non-interactive mode with model and session resume support.
`,
    status: "ready",
  },
  command: "hermes",
  promptMode: "argument",
  promptFlag: "--query",
  resumeFlag: "--resume",
  buildArgs: (config, ctx) => [
    "-Q",
    ...standardLocalArgs(config, ctx, {
      resumeFlag: "--resume",
      modelFlag: "--model",
    }),
  ],
});

export const hermes: ServerAdapterModule = {
  ...hermesLocal,
  info: { ...hermesLocal.info, type: "hermes" },
};

export const module: ServerAdapterModule = hermes;
