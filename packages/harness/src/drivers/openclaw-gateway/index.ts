import crypto, { randomUUID } from "node:crypto";
import type { AdapterExecutionResult, ServerAdapterModule } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import WebSocket from "ws";
import { openclawSessionCodec } from "../../shared/session-codec.js";

export const openclawGatewayInfo = {
  type: "openclaw_gateway" as const,
  label: "OpenClaw Gateway",
  transport: "gateway" as const,
  models: [{ id: "default", label: "Default" }],
  agentConfigurationDoc: `# openclaw_gateway

Connects to OpenClaw's WebSocket gateway using token/password auth, sends agent requests, streams assistant events, and waits for terminal completion.
`,
  status: "ready" as const,
};

type Frame = Record<string, unknown>;
type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKeyPem: string;
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function record(value: unknown): Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Frame)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function deviceIdentity(config: Frame): DeviceIdentity {
  const privateKey = stringValue(config.devicePrivateKeyPem);
  const keyPair = privateKey
    ? { privateKey: crypto.createPrivateKey(privateKey), publicKey: undefined }
    : crypto.generateKeyPairSync("ed25519");
  const resolvedPrivateKey = privateKey
    ? privateKey
    : keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = crypto.createPublicKey(keyPair.privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const raw =
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
      ? spki.subarray(ED25519_SPKI_PREFIX.length)
      : spki;
  return {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKey: base64Url(raw),
    privateKeyPem: resolvedPrivateKey,
  };
}

function deviceSignature(identity: DeviceIdentity, input: string): string {
  return base64Url(
    crypto.sign(null, Buffer.from(input, "utf8"), crypto.createPrivateKey(identity.privateKeyPem)),
  );
}

function resultError(message: string, code: string): AdapterExecutionResult {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: 1,
    timedOut: false,
    errorMessage: message,
    errorCode: code,
    errorFamily: "transient_upstream",
    summary: "OpenClaw Gateway failed",
    usageBasis: "per_run",
    clearSession: false,
  };
}

function wsRequest(
  ws: WebSocket,
  method: string,
  params: Frame,
  timeoutMs: number,
): Promise<Frame> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`OpenClaw request timed out: ${method}`)),
      timeoutMs,
    );
    const handle = (raw: WebSocket.RawData) => {
      let value: Frame;
      try {
        value = record(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (value.type !== "res" || value.id !== id) return;
      clearTimeout(timer);
      ws.off("message", handle);
      if (value.ok !== true)
        reject(
          new Error(
            stringValue(record(value.error).message) ?? `OpenClaw request failed: ${method}`,
          ),
        );
      else resolve(record(value.payload));
    };
    ws.on("message", handle);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

export const openclawGateway: ServerAdapterModule = {
  info: openclawGatewayInfo,
  sessionCodec: openclawSessionCodec,
  async execute(ctx) {
    const config = record(ctx.config);
    const url = stringValue(config.url);
    if (!url) return resultError("OpenClaw Gateway requires url", "openclaw_gateway_url_missing");
    const token =
      stringValue(config.token) ?? stringValue(record(config.env).OPENCLAW_GATEWAY_TOKEN);
    const password = stringValue(config.password);
    const disableDeviceAuth = config.disableDeviceAuth === true;
    let identity: DeviceIdentity | undefined;
    try {
      identity = disableDeviceAuth ? undefined : deviceIdentity(config);
    } catch (error) {
      return resultError(
        error instanceof Error ? error.message : String(error),
        "openclaw_gateway_auth_config",
      );
    }
    const timeoutMs =
      typeof config.timeoutSec === "number" && config.timeoutSec > 0
        ? config.timeoutSec * 1_000
        : 120_000;
    const clientId = stringValue(config.clientId) ?? "aaspai-harness";
    const clientVersion = stringValue(config.clientVersion) ?? "1";
    const role = stringValue(config.role) ?? "operator";
    const scopes = Array.isArray(config.scopes)
      ? config.scopes.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : ["operator.admin"];
    const headers =
      typeof config.headers === "object" && config.headers !== null
        ? (config.headers as Record<string, string>)
        : undefined;
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    const chunks: string[] = [];
    let connected = false;
    const onMessage = (raw: WebSocket.RawData) => {
      let value: Frame;
      try {
        value = record(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (value.type !== "event" || value.event !== "agent") return;
      const payload = record(value.payload);
      const data = record(payload.data);
      const text = stringValue(data.delta) ?? stringValue(data.text);
      if (text) {
        chunks.push(text);
        void ctx.onLog(
          "stdout",
          `${JSON.stringify({ kind: "assistant", ts: new Date().toISOString(), text, delta: Boolean(data.delta) })}\n`,
        );
      }
    };
    ws.on("message", onMessage);
    const close = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };
    const abort = () => close();
    if (ctx.signal?.aborted) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("OpenClaw WebSocket connection timed out")),
          timeoutMs,
        );
        ws.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const challenge = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("OpenClaw challenge timed out")),
          timeoutMs,
        );
        const handler = (raw: WebSocket.RawData) => {
          let value: Frame;
          try {
            value = record(JSON.parse(raw.toString()));
          } catch {
            return;
          }
          if (value.type !== "event" || value.event !== "connect.challenge") return;
          const nonce = stringValue(record(value.payload).nonce);
          if (!nonce) return;
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(nonce);
        };
        ws.on("message", handler);
      });
      const signedAt = Date.now();
      const devicePayload = identity
        ? [
            "v3",
            identity.deviceId,
            clientId,
            "backend",
            role,
            scopes.join(","),
            String(signedAt),
            token ?? "",
            challenge,
            process.platform,
            "",
          ].join("|")
        : undefined;
      const hello = await wsRequest(
        ws,
        "connect",
        {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: clientId,
            version: clientVersion,
            platform: process.platform,
            mode: "backend",
          },
          role,
          scopes,
          auth:
            token || password
              ? { ...(token ? { token } : {}), ...(password ? { password } : {}) }
              : {},
          ...(identity && devicePayload
            ? {
                device: {
                  id: identity.deviceId,
                  publicKey: identity.publicKey,
                  signature: deviceSignature(identity, devicePayload),
                  signedAt,
                  nonce: challenge,
                },
              }
            : { nonce: challenge }),
        },
        timeoutMs,
      );
      connected = true;
      const configuredSessionKey = stringValue(config.sessionKey);
      const strategy = stringValue(config.sessionKeyStrategy)?.toLowerCase() ?? "issue";
      const issueId = stringValue(ctx.context.issueId);
      const sessionKey =
        stringValue(ctx.runtime.sessionParams?.sessionKey) ??
        (strategy === "run"
          ? `agent:${ctx.agent.id}:run:${ctx.runId}`
          : strategy === "issue" && issueId
            ? `agent:${ctx.agent.id}:issue:${issueId}`
            : (configuredSessionKey ?? `agent:${ctx.agent.id}`));
      const accepted = await wsRequest(
        ws,
        "agent",
        {
          message: ctx.context.prompt,
          sessionKey,
          idempotencyKey: ctx.runId,
          ...(stringValue(config.agentId) ? { agentId: stringValue(config.agentId) } : {}),
        },
        timeoutMs,
      );
      const runId = stringValue(accepted.runId) ?? ctx.runId;
      const status = stringValue(accepted.status)?.toLowerCase();
      const final =
        status === "ok" || status === "completed"
          ? accepted
          : await wsRequest(ws, "agent.wait", { runId, timeoutMs }, timeoutMs);
      const finalStatus = stringValue(final.status)?.toLowerCase() ?? "ok";
      const failed = ["error", "failed", "cancelled", "timeout"].includes(finalStatus);
      return {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        exitCode: failed ? 1 : 0,
        signal: finalStatus === "cancelled" ? "SIGTERM" : undefined,
        timedOut: finalStatus === "timeout",
        errorMessage: failed
          ? (stringValue(final.error) ?? `OpenClaw run ${finalStatus}`)
          : undefined,
        errorCode: failed ? "openclaw_gateway_run_failed" : undefined,
        errorFamily: failed ? "transient_upstream" : undefined,
        summary:
          (stringValue(final.result) ?? stringValue(final.output) ?? chunks.join("")) ||
          finalStatus,
        usageBasis: "per_run",
        sessionId: sessionKey,
        sessionDisplayId: sessionKey,
        sessionParams: { sessionKey, runId },
        provider: "openclaw",
        biller: "openclaw-gateway",
        billingType: "api",
        resultJson: { hello, accepted, final } as JsonObject,
        clearSession: false,
      };
    } catch (error) {
      return resultError(
        error instanceof Error ? error.message : String(error),
        connected ? "openclaw_gateway_run_failed" : "openclaw_gateway_connect_failed",
      );
    } finally {
      ctx.signal?.removeEventListener("abort", abort);
      close();
    }
  },
  async testEnvironment(ctx) {
    const config = record(ctx.config);
    const url = stringValue(config.url);
    return {
      ok: Boolean(url),
      checks: [
        {
          name: "openclaw_gateway_url",
          level: url ? "info" : "error",
          message: url ? `OpenClaw endpoint configured: ${url}` : "OpenClaw Gateway requires url",
        },
      ],
    };
  },
  describe: () => ({
    type: "openclaw_gateway",
    label: openclawGatewayInfo.label,
    models: [...openclawGatewayInfo.models],
    nativeTools: [],
    supportsCancel: false,
    supportsCompact: false,
    supportsFork: false,
    supportsResume: true,
    supportsThinking: false,
    supportsForkSession: false,
  }),
};

export const module: ServerAdapterModule = openclawGateway;
