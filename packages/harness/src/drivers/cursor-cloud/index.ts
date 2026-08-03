import type { AdapterExecutionResult, ServerAdapterModule } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { cursorCloudSessionCodec } from "../../shared/session-codec.js";

const DEFAULT_ENDPOINT = "https://api.cursor.com/v0/agents";

export const cursorCloudInfo = {
  type: "cursor_cloud" as const,
  label: "Cursor Cloud",
  transport: "cloud_sdk" as const,
  models: [
    { id: "auto", label: "Auto" },
    { id: "composer-1.5", label: "Composer 1.5" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  ],
  agentConfigurationDoc: `# cursor_cloud

Uses Cursor's HTTPS agent API. Configure apiKey or CURSOR_API_KEY and optionally endpoint, model, repositoryUrl, startingRef, and timeoutSec.
`,
  status: "ready" as const,
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return record(JSON.parse(text));
  } catch {
    return text ? { result: text } : {};
  }
}

function errorResult(
  message: string,
  family: "auth" | "config" | "transient_upstream" = "config",
): AdapterExecutionResult {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: 1,
    timedOut: false,
    errorMessage: message,
    errorCode: "cursor_cloud_failed",
    errorFamily: family,
    summary: "Cursor Cloud failed",
    usageBasis: "per_run",
    clearSession: false,
  };
}

export const cursorCloud: ServerAdapterModule = {
  info: cursorCloudInfo,
  sessionCodec: cursorCloudSessionCodec,
  async execute(ctx) {
    const config = record(ctx.config);
    const apiKey = stringValue(config.apiKey) ?? stringValue(record(config.env).CURSOR_API_KEY);
    if (!apiKey) return errorResult("Cursor Cloud requires apiKey or CURSOR_API_KEY", "auth");
    const endpoint = stringValue(config.endpoint) ?? DEFAULT_ENDPOINT;
    const payload = {
      prompt: ctx.context.prompt,
      ...(stringValue(config.model) ? { model: stringValue(config.model) } : {}),
      ...(stringValue(config.repositoryUrl)
        ? { repository: stringValue(config.repositoryUrl) }
        : {}),
      ...(stringValue(config.startingRef) ? { startingRef: stringValue(config.startingRef) } : {}),
      ...(ctx.runtime.sessionParams?.cursorAgentId
        ? { agentId: ctx.runtime.sessionParams.cursorAgentId }
        : {}),
    };
    const timeoutMs =
      typeof config.timeoutSec === "number" && config.timeoutSec > 0
        ? config.timeoutSec * 1_000
        : 15 * 60_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    if (ctx.signal?.aborted) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const initial = await readJson(response);
      if (!response.ok)
        return errorResult(
          stringValue(initial.error) ?? `Cursor Cloud HTTP ${response.status}`,
          "transient_upstream",
        );
      const agentId =
        stringValue(initial.agentId) ?? stringValue(initial.agent_id) ?? stringValue(initial.id);
      const statusUrl =
        stringValue(initial.statusUrl) ??
        stringValue(initial.status_url) ??
        (agentId ? `${endpoint.replace(/\/$/, "")}/${encodeURIComponent(agentId)}` : undefined);
      let result = initial;
      const terminal = new Set(["completed", "failed", "cancelled", "error"]);
      while (
        statusUrl &&
        !terminal.has((stringValue(result.status) ?? "completed").toLowerCase())
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const polled = await fetch(statusUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        result = await readJson(polled);
        const delta = stringValue(result.delta) ?? stringValue(result.message);
        if (delta)
          await ctx.onLog(
            "stdout",
            `${JSON.stringify({ kind: "assistant", ts: new Date().toISOString(), text: delta, delta: true })}\n`,
          );
      }
      const summary =
        stringValue(result.result) ??
        stringValue(result.output) ??
        stringValue(result.message) ??
        "Cursor Cloud completed";
      if (summary)
        await ctx.onLog(
          "stdout",
          `${JSON.stringify({ kind: "assistant", ts: new Date().toISOString(), text: summary })}\n`,
        );
      const failed = ["failed", "cancelled", "error"].includes(
        (stringValue(result.status) ?? "").toLowerCase(),
      );
      const sessionParams: JsonObject | undefined = agentId
        ? {
            cursorAgentId: agentId,
            ...((stringValue(result.runId) ?? stringValue(result.run_id))
              ? { latestRunId: stringValue(result.runId) ?? stringValue(result.run_id) }
              : {}),
          }
        : undefined;
      return {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        exitCode: failed ? 1 : 0,
        timedOut: controller.signal.aborted && !ctx.signal?.aborted,
        errorMessage: failed ? summary : undefined,
        errorCode: failed ? "cursor_cloud_run_failed" : undefined,
        errorFamily: failed ? "transient_upstream" : undefined,
        summary,
        usageBasis: "per_run",
        sessionId: agentId,
        sessionDisplayId: agentId,
        sessionParams,
        model: stringValue(result.model) ?? stringValue(config.model),
        billingType: "api",
        provider: "cursor",
        biller: "cursor-cloud",
        resultJson: result as JsonObject,
        clearSession: false,
      };
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : String(error),
        "transient_upstream",
      );
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", abort);
    }
  },
  async testEnvironment(ctx) {
    const config = record(ctx.config);
    const hasKey = Boolean(
      stringValue(config.apiKey) ?? stringValue(record(config.env).CURSOR_API_KEY),
    );
    return {
      ok: hasKey,
      checks: [
        {
          name: "cursor_cloud_auth",
          level: hasKey ? "info" : "error",
          message: hasKey
            ? "Cursor Cloud credentials configured"
            : "Cursor Cloud requires apiKey or CURSOR_API_KEY",
        },
      ],
    };
  },
  describe: () => ({
    type: "cursor_cloud",
    label: cursorCloudInfo.label,
    models: [...cursorCloudInfo.models],
    nativeTools: [],
    supportsCancel: false,
    supportsCompact: false,
    supportsFork: false,
    supportsResume: true,
    supportsThinking: false,
    supportsForkSession: false,
  }),
};

export const module: ServerAdapterModule = cursorCloud;
