import { type ExecutionTarget, sandboxProviderSchema } from "@aaspai/contracts/runtime";
import { z } from "zod";

/**
 * Runtime selection for a single chat turn.
 *
 * Resolution order (highest precedence first):
 *   1. `runtime` from the request body (user override)
 *   2. the agent's `runtime.default` (from AGENT.md frontmatter)
 *   3. `{ kind: "local" }`
 *
 * The body override is validated strictly (an unknown sandbox provider
 * is a 400), while the agent's default is best-effort — if it doesn't
 * parse as a valid ExecutionTarget we silently fall back to local.
 */
export const chatRuntimeSchema = z
  .object({
    kind: z.enum(["local", "sandbox"]),
    provider: sandboxProviderSchema.optional(),
    remoteCwd: z.string().trim().min(1).max(8_192).optional(),
    apiKey: z.string().trim().min(1).max(2_048).optional(),
    template: z.string().trim().min(1).max(256).optional(),
    timeoutMs: z.number().int().positive().optional(),
    envPassthrough: z.boolean().optional(),
    cwd: z.string().trim().min(1).max(8_192).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ChatRuntime = z.infer<typeof chatRuntimeSchema>;

export type ResolveChatRuntimeResult =
  | { ok: true; runtime: ExecutionTarget }
  | { ok: false; error: string };

/**
 * Resolve the ExecutionTarget for a chat turn. Returns `{ ok: false }`
 * only when the BODY override is invalid (the caller should respond
 * 400). Invalid agent defaults degrade to local.
 */
export function resolveChatRuntime(
  bodyRuntime: unknown,
  agentRuntime: unknown,
): ResolveChatRuntimeResult {
  if (bodyRuntime !== undefined && bodyRuntime !== null) {
    const parsed = chatRuntimeSchema.safeParse(bodyRuntime);
    if (!parsed.success) {
      return { ok: false, error: "invalid runtime in request body" };
    }
    const runtime = normalizeChatRuntime(parsed.data);
    if (!runtime) return { ok: false, error: "invalid runtime in request body" };
    return { ok: true, runtime };
  }

  const defaultRuntime = (agentRuntime as { default?: unknown } | null | undefined)?.default;
  const fromAgent = defaultRuntime !== undefined ? normalizeChatRuntime(defaultRuntime) : undefined;
  if (fromAgent) return { ok: true, runtime: fromAgent };

  return { ok: true, runtime: { kind: "local", envPassthrough: false } };
}

function normalizeChatRuntime(input: unknown): ExecutionTarget | null {
  const parsed = chatRuntimeSchema.safeParse(input);
  if (!parsed.success) return null;
  const r = parsed.data;
  if (r.kind === "local") {
    return { kind: "local", envPassthrough: r.envPassthrough ?? false };
  }
  if (r.provider === "daytona") {
    return {
      kind: "sandbox",
      provider: "daytona",
      apiKey: r.apiKey,
      template: r.template,
      remoteCwd: r.remoteCwd ?? "/workspace",
      timeoutMs: r.timeoutMs,
      metadata: r.metadata as never,
    };
  }
  // Other sandbox providers require explicit credentials; chat only
  // wires up daytona today.
  return null;
}
