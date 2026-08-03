import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import { executeAcp, resolveAcpEngine, testAcpEnvironment } from "../../shared/acp.js";
import { createLocalAgentAdapter, standardLocalArgs } from "../../shared/local-agent.js";
import { geminiLocalConfigSchema, parseGeminiLocalConfig } from "./config.js";

const cliAdapter = createLocalAgentAdapter({
  info: {
    type: "gemini_local",
    label: "Gemini CLI",
    transport: "local_subprocess",
    models: [
      { id: "auto", label: "Auto" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
    ],
    agentConfigurationDoc: `# gemini_local

Runs Gemini CLI with ACP auto-selection, CLI fallback, structured output, model selection, resumable sessions, and managed environment isolation.
`,
    status: "ready",
  },
  command: "gemini",
  promptMode: "argument",
  promptFlag: "--prompt",
  resumeFlag: "--resume",
  buildArgs: (config, ctx) => [
    "--output-format",
    "stream-json",
    ...standardLocalArgs(config, ctx, { resumeFlag: "--resume", modelFlag: "--model" }),
  ],
});

export const geminiLocal: ServerAdapterModule = {
  ...cliAdapter,
  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    let config: ReturnType<typeof parseGeminiLocalConfig>;
    try {
      config = parseGeminiLocalConfig(ctx.config);
    } catch (error) {
      return {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        exitCode: 1,
        timedOut: false,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorCode: "config_invalid",
        errorFamily: "config",
        summary: "Invalid gemini_local config",
        usageBasis: "per_run",
        clearSession: false,
      };
    }
    const engine = await resolveAcpEngine("gemini", {
      config: ctx.config,
      cwd: ctx.context.cwd,
      execution: ctx.execution,
      organizationId: ctx.organizationId,
      agentId: ctx.agent.id,
    });
    if (engine.engine === "acp")
      return executeAcp(ctx, "gemini", { timeoutSec: config.timeoutSec });
    if (!engine.explicit && engine.fallbackReason) {
      await ctx.onLog(
        "stderr",
        `[aaspai] Gemini ACP unavailable; falling back to CLI. ${engine.fallbackReason}\n`,
      );
    }
    return cliAdapter.execute(ctx);
  },
  async testEnvironment(ctx) {
    const parsed = geminiLocalConfigSchema.safeParse(ctx.config ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        checks: [{ name: "config", level: "error", message: parsed.error.message }],
      };
    }
    const engine = await resolveAcpEngine("gemini", {
      config: parsed.data,
      cwd: ctx.cwd,
    });
    if (engine.engine === "acp") return testAcpEnvironment("gemini", ctx);
    const result = await cliAdapter.testEnvironment(ctx);
    return engine.fallbackReason
      ? {
          ...result,
          checks: [
            {
              name: "acp_fallback",
              level: "warn",
              message: `ACP unavailable; testing the Gemini CLI fallback: ${engine.fallbackReason}`,
            },
            ...result.checks,
          ],
        }
      : result;
  },
};

export const module: ServerAdapterModule = geminiLocal;
