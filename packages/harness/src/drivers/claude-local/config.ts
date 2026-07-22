import { nonNegativeIntegerSchema, positiveIntegerSchema } from "@aaspai/contracts/primitives";
import { z } from "zod";

const claudeEffortSchema = z.enum(["low", "medium", "high"]);
const claudePermissionModeSchema = z.enum([
  "default",
  "accept-edits",
  "bypass-permissions",
  "plan",
]);
const claudeEngineSchema = z.enum(["auto", "cli", "acp"]);

export const claudeLocalConfigSchema = z
  .object({
    command: z.string().trim().min(1).max(256).default("claude"),
    model: z.string().trim().min(1).max(256).optional(),
    effort: claudeEffortSchema.optional(),
    permissionMode: claudePermissionModeSchema.default("bypass-permissions"),
    engine: claudeEngineSchema.default("auto"),
    maxTurns: positiveIntegerSchema.max(1_000).optional(),
    timeoutSec: positiveIntegerSchema.max(86_400).optional(),
    graceSec: positiveIntegerSchema.max(300).default(15),
    extraArgs: z.array(z.string().max(1_024)).max(64).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().trim().min(1).max(8_192).optional(),
    chrome: z.boolean().default(false),
    dangerouslySkipPermissions: z.boolean().default(true),
  })
  .strict();
export type ClaudeLocalConfig = z.infer<typeof claudeLocalConfigSchema>;

export function parseClaudeLocalConfig(input: unknown): ClaudeLocalConfig {
  if (input === undefined || input === null) return DEFAULT_CLAUDE_LOCAL_CONFIG;
  return claudeLocalConfigSchema.parse(input);
}

export const DEFAULT_CLAUDE_LOCAL_CONFIG: ClaudeLocalConfig = Object.freeze({
  command: "claude",
  permissionMode: "bypass-permissions",
  engine: "auto",
  graceSec: 15,
  extraArgs: [],
  env: {},
  chrome: false,
  dangerouslySkipPermissions: true,
}) as ClaudeLocalConfig;

export const claudeLocalInfo = {
  type: "claude_local" as const,
  label: "Claude Code",
  transport: "local_subprocess" as const,
  models: [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  ],
  agentConfigurationDoc: `# claude_local agent configuration

Adapter: claude_local

Core fields:
- command (string, default "claude"): CLI binary on PATH
- model (string, optional): Claude model id
- effort (string, optional): "low" | "medium" | "high"
- permissionMode (string, default "bypass-permissions"): how Claude asks for approvals
- engine (string, default "auto"): "auto" | "cli" | "acp"
- maxTurns (number, optional): cap agent turns per run
- timeoutSec (number, optional): hard timeout in seconds
- graceSec (number, default 15): SIGTERM grace before SIGKILL
- extraArgs (string[]): additional CLI args
- env (object): extra KEY=VALUE env
- cwd (string, optional): default working directory
- chrome (boolean, default false): pass --chrome
- dangerouslySkipPermissions (boolean, default true): pass --dangerously-skip-permissions

Notes:
- The adapter spawns \`claude --output-format stream-json --verbose ...\` and parses
  one JSON event per line from stdout. Sessions are resumed by passing
  --resume <sessionId> when the run context carries a previous sessionId.
- Cross-run persistence: the adapter never \`git push\`es. State is carried
  through the local cwd only. See packages/harness/AUTHORING.md.
`,
  status: "ready" as const,
};

export const claudeStreamEventSchema = z
  .object({
    type: z.string().trim().min(1).max(64),
    subtype: z.string().trim().min(1).max(64).optional(),
    session_id: z.string().trim().min(1).max(512).optional(),
    message: z.unknown().optional(),
    error: z.unknown().optional(),
    usage: z
      .object({
        input_tokens: nonNegativeIntegerSchema.optional(),
        output_tokens: nonNegativeIntegerSchema.optional(),
        cache_read_input_tokens: nonNegativeIntegerSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();
export type ClaudeStreamEvent = z.infer<typeof claudeStreamEventSchema>;
