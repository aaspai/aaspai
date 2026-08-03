import type { AdapterExecutionResult, ServerAdapterModule } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { hermesSessionCodec } from "../../shared/session-codec.js";

export const hermesGatewayInfo = {
  type: "hermes_gateway" as const,
  label: "Hermes Gateway",
  transport: "gateway" as const,
  models: [{ id: "auto", label: "Auto" }],
  agentConfigurationDoc: `# hermes_gateway

Runs Hermes Gateway HTTP jobs with bearer authentication, polling, session continuation, cancellation, and structured result events.
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

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return record(JSON.parse(text));
  } catch {
    return text ? { output: text } : {};
  }
}

function parseSseFrames(buffer: string): {
  frames: Array<{ event?: string; data: string }>;
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  return {
    frames: parts
      .map((frame) => {
        let event: string | undefined;
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        return { event, data: data.join("\n") };
      })
      .filter((frame) => frame.data.length > 0),
    rest,
  };
}

function errorResult(message: string, code = "hermes_gateway_failed"): AdapterExecutionResult {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: 1,
    timedOut: false,
    errorMessage: message,
    errorCode: code,
    errorFamily: "transient_upstream",
    summary: "Hermes Gateway failed",
    usageBasis: "per_run",
    clearSession: false,
  };
}

export const hermesGateway: ServerAdapterModule = {
  info: hermesGatewayInfo,
  sessionCodec: hermesSessionCodec,
  async execute(ctx) {
    const config = record(ctx.config);
    const baseUrl = (stringValue(config.baseUrl) ?? "http://127.0.0.1:8000").replace(/\/$/, "");
    const apiKey = stringValue(config.apiKey) ?? stringValue(record(config.env).HERMES_API_KEY);
    const headers = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    const sessionId =
      stringValue(ctx.runtime.sessionParams?.hermesSessionId) ?? ctx.runtime.sessionId;
    const controller = new AbortController();
    let activeRunId: string | undefined;
    const abort = () => controller.abort();
    if (ctx.signal?.aborted) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
    try {
      const started = await fetch(`${baseUrl}/v1/runs`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          prompt: ctx.context.prompt,
          ...(stringValue(config.model) ? { model: stringValue(config.model) } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(stringValue(config.sessionKey)
            ? { session_key: stringValue(config.sessionKey) }
            : {}),
        }),
      });
      const initial = await responseJson(started);
      if (!started.ok)
        return errorResult(stringValue(initial.error) ?? `Hermes Gateway HTTP ${started.status}`);
      const runId =
        stringValue(initial.run_id) ?? stringValue(initial.runId) ?? stringValue(initial.id);
      if (!runId)
        return errorResult(
          "Hermes Gateway did not return a run id",
          "hermes_gateway_protocol_error",
        );
      activeRunId = runId;
      let state = initial;
      const chunks: string[] = [];
      const timeoutMs =
        typeof config.timeoutSec === "number" && config.timeoutSec > 0
          ? config.timeoutSec * 1_000
          : 15 * 60_000;
      const startedAt = Date.now();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const consumeSse = async (): Promise<boolean> => {
        const response = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
          headers: { ...headers, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return false;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          const parsed = parseSseFrames(buffer);
          buffer = parsed.rest;
          for (const frame of parsed.frames) {
            try {
              const event = record(JSON.parse(frame.data));
              const delta = stringValue(event.delta) ?? stringValue(event.text_delta);
              if (delta) {
                chunks.push(delta);
                await ctx.onLog(
                  "stdout",
                  `${JSON.stringify({ kind: "assistant", ts: new Date().toISOString(), text: delta, delta: true })}\n`,
                );
              }
              state = { ...state, ...event };
              const status = stringValue(state.status)?.toLowerCase();
              if (
                status &&
                ["completed", "failed", "error", "cancelled", "stopped"].includes(status)
              )
                return true;
            } catch {
              await ctx.onLog(
                "stderr",
                `[hermes-gateway] ignored malformed SSE frame (${frame.event ?? "message"})\n`,
              );
            }
          }
          if (chunk.done) break;
        }
        return false;
      };
      try {
        const initialStatus = stringValue(state.status)?.toLowerCase();
        let terminalSeen = Boolean(
          initialStatus &&
            ["completed", "failed", "error", "cancelled", "stopped"].includes(initialStatus),
        );
        try {
          if (!terminalSeen) terminalSeen = await consumeSse();
        } catch (error) {
          if (!controller.signal.aborted)
            await ctx.onLog(
              "stderr",
              `[hermes-gateway] SSE unavailable; falling back to polling: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
        while (!terminalSeen && Date.now() - startedAt < timeoutMs && !controller.signal.aborted) {
          const status = stringValue(state.status)?.toLowerCase();
          if (status && ["completed", "failed", "error", "cancelled", "stopped"].includes(status))
            break;
          await new Promise((resolve) => setTimeout(resolve, 500));
          const response = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
            headers,
            signal: controller.signal,
          });
          state = await responseJson(response);
          const delta = stringValue(state.delta) ?? stringValue(state.text_delta);
          if (delta) {
            chunks.push(delta);
            await ctx.onLog(
              "stdout",
              `${JSON.stringify({ kind: "assistant", ts: new Date().toISOString(), text: delta, delta: true })}\n`,
            );
          }
        }
      } finally {
        clearTimeout(timeout);
      }
      const status = stringValue(state.status)?.toLowerCase() ?? "completed";
      const output = stringValue(state.output) ?? stringValue(state.result) ?? chunks.join("");
      const failed = ["failed", "error", "cancelled", "stopped"].includes(status);
      return {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        exitCode: failed || controller.signal.aborted ? 1 : 0,
        signal: controller.signal.aborted ? "SIGTERM" : undefined,
        timedOut: Date.now() - startedAt >= timeoutMs && !failed,
        errorMessage: failed ? (stringValue(state.error) ?? `Hermes run ${status}`) : undefined,
        errorCode: failed ? "hermes_gateway_run_failed" : undefined,
        errorFamily: failed ? "transient_upstream" : undefined,
        summary: output || status,
        usageBasis: "per_run",
        sessionId: stringValue(state.session_id) ?? sessionId,
        sessionDisplayId: stringValue(state.session_id) ?? sessionId,
        sessionParams: {
          hermesRunId: runId,
          ...(stringValue(state.session_id)
            ? { hermesSessionId: stringValue(state.session_id) }
            : {}),
        },
        provider: "hermes",
        biller: "hermes-gateway",
        billingType: "api",
        model: stringValue(state.model) ?? stringValue(config.model),
        resultJson: state as JsonObject,
        clearSession: false,
      };
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    } finally {
      if (activeRunId && controller.signal.aborted) {
        await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(activeRunId)}/stop`, {
          method: "POST",
          headers,
        }).catch(() => {});
      }
      ctx.signal?.removeEventListener("abort", abort);
    }
  },
  async testEnvironment(ctx) {
    const config = record(ctx.config);
    const baseUrl = (stringValue(config.baseUrl) ?? "http://127.0.0.1:8000").replace(/\/$/, "");
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return {
        ok: response.ok,
        checks: [
          {
            name: "hermes_gateway",
            level: response.ok ? "info" : "error",
            message: response.ok
              ? "Hermes Gateway is reachable"
              : `Hermes Gateway returned HTTP ${response.status}`,
          },
        ],
      };
    } catch (error) {
      return {
        ok: false,
        checks: [
          {
            name: "hermes_gateway",
            level: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
  describe: () => ({
    type: "hermes_gateway",
    label: hermesGatewayInfo.label,
    models: [...hermesGatewayInfo.models],
    nativeTools: [],
    supportsCancel: false,
    supportsCompact: false,
    supportsFork: false,
    supportsResume: true,
    supportsThinking: false,
    supportsForkSession: false,
  }),
};

export const module: ServerAdapterModule = hermesGateway;
