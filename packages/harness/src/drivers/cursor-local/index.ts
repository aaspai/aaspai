import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { createLocalAgentAdapter, standardLocalArgs } from "../../shared/local-agent.js";

export const cursorLocal: ServerAdapterModule = createLocalAgentAdapter({
  info: {
    type: "cursor_local",
    label: "Cursor Agent",
    transport: "local_subprocess",
    models: [
      { id: "auto", label: "Auto" },
      { id: "composer-1.5", label: "Composer 1.5" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "sonnet-4.6", label: "Sonnet 4.6" },
    ],
    agentConfigurationDoc: `# cursor_local

Runs Cursor Agent with stream-json output, model selection, resumable sessions, and the managed runtime process boundary.
`,
    status: "ready",
  },
  command: "agent",
  promptMode: "stdin",
  resumeFlag: "--resume",
  buildArgs: (config, ctx) => [
    "-p",
    "--output-format",
    "stream-json",
    ...standardLocalArgs(config, ctx, {
      resumeFlag: "--resume",
      modelFlag: "--model",
      modeFlag: "--mode",
      yoloFlag: "--yolo",
    }),
  ],
});

export const cursorLocalInfo = cursorLocal.info;

export const module: ServerAdapterModule = cursorLocal;
