import { z } from "zod";
import { nonNegativeIntegerSchema, positiveIntegerSchema } from "@aaspai/contracts/primitives";

const codexEngineSchema = z.enum(["auto", "cli", "acp"]);
const codexSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);

export const codexLocalConfigSchema = z
  .object({
    command: z.string().trim().min(1).max(256).default("codex"),
    model: z.string().trim().min(1).max(256).optional(),
    modelReasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    engine: codexEngineSchema.default("auto"),
    sandbox: codexSandboxSchema.default("workspace-write"),
    approvalMode: z.enum(["untrusted", "on-failure", "on-request", "never"]).default("never"),
    maxTurns: positiveIntegerSchema.max(1_000).optional(),
    timeoutSec: positiveIntegerSchema.max(86_400).optional(),
    graceSec: positiveIntegerSchema.max(300).default(15),
    extraArgs: z.array(z.string().max(1_024)).max(64).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().trim().min(1).max(8_192).optional(),
    outputInactivityTimeoutMs: positiveIntegerSchema.max(3_600_000).default(7 * 60_000),
  })
  .strict();
export type CodexLocalConfig = z.infer<typeof codexLocalConfigSchema>;

export function parseCodexLocalConfig(input: unknown): CodexLocalConfig {
  if (input === undefined || input === null) return DEFAULT_CODEX_LOCAL_CONFIG;
  return codexLocalConfigSchema.parse(input);
}

export const DEFAULT_CODEX_LOCAL_CONFIG: CodexLocalConfig = Object.freeze({
  command: "codex",
  engine: "auto",
  sandbox: "workspace-write",
  approvalMode: "never",
  graceSec: 15,
  extraArgs: [],
  env: {},
  outputInactivityTimeoutMs: 7 * 60_000,
}) as CodexLocalConfig;

export const codexLocalInfo = {
  type: "codex_local" as const,
  label: "OpenAI Codex",
  transport: "local_subprocess" as const,
  models: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
  ],
  agentConfigurationDoc: `# codex_local agent configuration

Adapter: codex_local

Core fields:
- command (string, default "codex"): CLI binary on PATH
- model (string, optional): OpenAI model id (e.g. gpt-5-codex)
- modelReasoningEffort (string, optional): "low" | "medium" | "high"
- engine (string, default "auto"): "auto" | "cli" | "acp"
- sandbox (string, default "workspace-write"): "read-only" | "workspace-write" | "danger-full-access"
- approvalMode (string, default "never"): "untrusted" | "on-failure" | "on-request" | "never"
- maxTurns (number, optional): cap agent turns per run
- timeoutSec (number, optional): hard timeout in seconds
- graceSec (number, default 15): SIGTERM grace before SIGKILL
- extraArgs (string[]): additional CLI args
- env (object): extra KEY=VALUE env (OPENAI_API_KEY is intentionally scrubbed)
- cwd (string, optional): default working directory
- outputInactivityTimeoutMs (number, default 420000): kill the run if no event arrives within this window

Notes:
- Spawns 'codex exec --json' (or the codex binary with the equivalent exec subcommand) and parses
  one JSON event per stdout line.
- Cross-run persistence: never does 'git push'. See packages/harness/AUTHORING.md.
`,
  status: "ready" as const,
};

export const codexStreamEventSchema = z
  .object({
    type: z.string().trim().min(1).max(64),
    thread_id: z.string().trim().min(1).max(512).optional(),
    session_id: z.string().trim().min(1).max(512).optional(),
    item: z.unknown().optional(),
    usage: z
      .object({
        input_tokens: nonNegativeIntegerSchema.optional(),
        output_tokens: nonNegativeIntegerSchema.optional(),
        cached_input_tokens: nonNegativeIntegerSchema.optional(),
      })
      .strict()
      .optional(),
    error: z.unknown().optional(),
  })
  .passthrough();
export type CodexStreamEvent = z.infer<typeof codexStreamEventSchema>;
