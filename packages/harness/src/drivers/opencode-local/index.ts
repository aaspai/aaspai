/**
 * OpenCode local adapter.
 *
 * Calls the OpenCode OpenAI-compatible chat completions API. The
 * opencode service exposes a standard `/v1/chat/completions` endpoint
 * with bearer auth, so this driver is a thin fetch client. No CLI
 * installation required — the API key is enough.
 *
 * Env:
 *   OPENCODE_API_KEY       (required) — set in the environment
 *   OPENCODE_BASE_URL      (optional) — default: https://api.opencode.ai/v1
 *
 * The agent's `adapterConfig` (or `ctx.config`) accepts:
 *   model       (string, default "gpt-4o-mini" — override per agent)
 *   temperature (number, default 0.7)
 *   maxTokens   (number, default 4096)
 *   systemPrompt (string, optional) — prepended to the request
 */
import { z } from "zod";
import { HARNESS_PROTOCOL_VERSION, type AdapterExecutionContext, type AdapterExecutionResult, type ServerAdapterModule } from "@aaspai/contracts/harness";

const DEFAULT_BASE_URL = "https://api.opencode.ai/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 120_000;

const opencodeConfigSchema = z
  .object({
    model: z.string().trim().min(1).max(256).default(DEFAULT_MODEL),
    temperature: z.number().min(0).max(2).default(0.7),
    maxTokens: z.number().int().positive().max(32_000).default(4_096),
    systemPrompt: z.string().max(32_768).optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().min(1).max(512).optional(), // can override the env var
  })
  .strict();
type OpenCodeConfig = z.infer<typeof opencodeConfigSchema>;

interface OpenCodeMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenCodeChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: string | null;
}

interface OpenCodeUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenCodeChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenCodeChoice[];
  usage?: OpenCodeUsage;
}

function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

function resolveConfig(ctx: AdapterExecutionContext): OpenCodeConfig {
  const merged: Record<string, unknown> = {
    ...((ctx.config as Record<string, unknown>) ?? {}),
  };
  // Allow systemPrompt in the context (Sessions puts it there for the
  // foundation slice)
  if (!merged.systemPrompt && ctx.context && typeof ctx.context === "object" && "systemPrompt" in ctx.context) {
    const sp = (ctx.context as { systemPrompt?: unknown }).systemPrompt;
    if (typeof sp === "string" && sp.length > 0) merged.systemPrompt = sp;
  }
  return opencodeConfigSchema.parse(merged);
}

function resolveApiKey(overridden?: string): string {
  const key = overridden ?? process.env.OPENCODE_API_KEY;
  if (!key) {
    throw new Error(
      "OPENCODE_API_KEY is not set. Export it in your environment before running a session against opencode_local.",
    );
  }
  return key;
}

function resolveBaseUrl(overridden?: string): string {
  return overridden ?? process.env.OPENCODE_BASE_URL ?? DEFAULT_BASE_URL;
}

async function callChatCompletions(
  baseUrl: string,
  apiKey: string,
  model: string,
  temperature: number,
  maxTokens: number,
  messages: OpenCodeMessage[],
): Promise<OpenCodeChatResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `opencode API ${res.status} ${res.statusText}: ${text.slice(0, 1_000)}`,
      );
    }
    return (await res.json()) as OpenCodeChatResponse;
  } finally {
    clearTimeout(timer);
  }
}

export const opencodeLocal: ServerAdapterModule = {
  info: {
    type: "opencode_local",
    label: "OpenCode (Local)",
    transport: "cloud_sdk",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini (default)" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
      { id: "claude-3-haiku", label: "Claude 3 Haiku" },
    ],
    agentConfigurationDoc:
      "OpenAI-compatible chat completions client. Set OPENCODE_API_KEY in the environment. The `model` field in adapterConfig picks the model (default gpt-4o-mini).",
    status: "ready",
  },
  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const startedAt = new Date();
    const config = resolveConfig(ctx);
    const apiKey = resolveApiKey(config.apiKey);
    const baseUrl = resolveBaseUrl(config.baseUrl);

    const prompt = typeof ctx.context === "object" && ctx.context !== null && "prompt" in ctx.context
      ? String((ctx.context as { prompt: unknown }).prompt ?? "")
      : "";

    const messages: OpenCodeMessage[] = [];
    if (config.systemPrompt) {
      messages.push({ role: "system", content: config.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    if (ctx.onMeta) {
      await ctx.onMeta({
        adapter: "opencode_local",
        model: config.model,
        provider: "opencode",
        baseUrl,
      });
    }
    if (ctx.onLog) {
      await ctx.onLog("stdout", JSON.stringify({
        kind: "init",
        ts: startedAt.toISOString(),
        model: config.model,
        baseUrl,
      }) + "\n");
    }

    const response = await callChatCompletions(
      baseUrl,
      apiKey,
      config.model,
      config.temperature,
      config.maxTokens,
      messages,
    );

    const choice = response.choices?.[0];
    const text = choice?.message?.content ?? "";
    const finishReason = choice?.finish_reason ?? "stop";
    const usage = response.usage;
    const inputTokens = usage?.prompt_tokens ?? estimateTokens(prompt) + (config.systemPrompt ? estimateTokens(config.systemPrompt) : 0);
    const outputTokens = usage?.completion_tokens ?? estimateTokens(text);

    if (ctx.onLog && text) {
      await ctx.onLog("stdout", JSON.stringify({
        kind: "assistant",
        ts: new Date().toISOString(),
        text,
      }) + "\n");
      await ctx.onLog("stdout", JSON.stringify({
        kind: "result",
        ts: new Date().toISOString(),
        summary: text.slice(0, 200),
        stopReason: finishReason,
      }) + "\n");
    }

    const sessionId = `oc_${response.id ?? cryptoRandomShort()}`;
    return {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      sessionId,
      sessionDisplayId: sessionId.slice(0, 12),
      sessionParams: { model: config.model, baseUrl, responseId: response.id },
      exitCode: 0,
      timedOut: false,
      usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
      usageBasis: "per_run",
      costUsd: undefined, // OpenCode pricing isn't known to the foundation
      billingType: "api",
      provider: "opencode",
      biller: "opencode",
      model: config.model,
      summary: text.slice(0, 500),
      clearSession: false,
    };
  },
  async testEnvironment() {
    if (!process.env.OPENCODE_API_KEY) {
      return {
        ok: false,
        checks: [
          { name: "opencode_api_key", level: "error", message: "OPENCODE_API_KEY is not set in the environment" },
        ],
      };
    }
    return {
      ok: true,
      checks: [
        { name: "opencode_api_key", level: "info", message: "OPENCODE_API_KEY is set" },
        { name: "opencode_endpoint", level: "info", message: `endpoint: ${process.env.OPENCODE_BASE_URL ?? DEFAULT_BASE_URL}` },
      ],
    };
  },
};

export const opencodeLocalInfo = opencodeLocal.info;
export { opencodeConfigSchema, type OpenCodeConfig };

function cryptoRandomShort(): string {
  return Math.random().toString(36).slice(2, 10);
}
