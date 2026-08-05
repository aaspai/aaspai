import { generateKeyPairSync } from "node:crypto";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { afterEach, describe, expect, it, vi } from "vitest";

const wsState = vi.hoisted(() => ({
  mode: "success" as
    | "success"
    | "connect_error"
    | "connect_string_error"
    | "agent_error"
    | "agent_error_no_message"
    | "connect_timeout"
    | "challenge_timeout"
    | "agent_timeout"
    | "wait"
    | "chunk"
    | "output"
    | "malformed"
    | "nostatus"
    | "final_failed"
    | "no_run_id"
    | "final_cancelled",
  instances: [] as unknown[],
}));

vi.mock("ws", () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    readyState = FakeWebSocket.OPEN;
    private closed = false;
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor(
      public readonly url: string,
      public readonly options?: unknown,
    ) {
      wsState.instances.push(this);
      queueMicrotask(() => {
        if (this.closed) {
          this.emit("error", new Error("socket closed"));
          return;
        }
        if (wsState.mode === "connect_error") {
          this.emit("error", new Error("socket unavailable"));
          return;
        }
        if (wsState.mode === "connect_string_error") {
          this.emit("error", "socket unavailable");
          return;
        }
        if (wsState.mode === "connect_timeout") return;
        this.emit("open");
        if (wsState.mode === "challenge_timeout") return;
        queueMicrotask(() =>
          (() => {
            if (wsState.mode === "malformed") {
              this.emit("message", Buffer.from("not-json"));
              this.emit("message", Buffer.from(JSON.stringify({ type: "event", event: "other" })));
              this.emit(
                "message",
                Buffer.from(
                  JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }),
                ),
              );
            }
            this.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  type: "event",
                  event: "connect.challenge",
                  payload: { nonce: "nonce-1" },
                }),
              ),
            );
          })(),
        );
      });
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? new Set();
      list.add(listener);
      this.listeners.set(event, list);
      return this;
    }

    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapper = (...args: unknown[]) => {
        this.off(event, wrapper);
        listener(...args);
      };
      return this.on(event, wrapper);
    }

    off(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
      return true;
    }

    send(raw: string) {
      if (this.closed) return;
      const request = JSON.parse(raw) as { id: string; method: string };
      queueMicrotask(() => {
        if (this.closed) return;
        if (request.method === "connect") {
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({ type: "res", id: request.id, ok: true, payload: { hello: "ok" } }),
            ),
          );
          return;
        }
        if (request.method === "agent" && wsState.mode === "agent_error") {
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok: false,
                error: { message: "agent rejected" },
              }),
            ),
          );
          return;
        }
        if (request.method === "agent" && wsState.mode === "agent_error_no_message") {
          this.emit(
            "message",
            Buffer.from(JSON.stringify({ type: "res", id: request.id, ok: false, error: {} })),
          );
          return;
        }
        if (request.method === "agent" && wsState.mode === "agent_timeout") return;
        if (request.method === "agent.wait" || request.method === "agent") {
          const status =
            (wsState.mode === "wait" ||
              wsState.mode === "chunk" ||
              wsState.mode === "nostatus" ||
              wsState.mode === "final_failed" ||
              wsState.mode === "no_run_id" ||
              wsState.mode === "final_cancelled") &&
            request.method === "agent"
              ? "running"
              : "completed";
          if (request.method === "agent.wait") {
            this.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  type: "res",
                  id: request.id,
                  ok: true,
                  payload:
                    wsState.mode === "final_failed"
                      ? { status: "failed" }
                      : wsState.mode === "final_cancelled"
                        ? { status: "cancelled" }
                        : wsState.mode === "nostatus"
                          ? { result: "waited" }
                          : {
                              status: "completed",
                              ...(wsState.mode === "chunk" ? {} : { result: "waited" }),
                            },
                }),
              ),
            );
            return;
          }
          if (status === "running") {
            if (wsState.mode === "chunk") {
              this.emit(
                "message",
                Buffer.from(
                  JSON.stringify({
                    type: "event",
                    event: "agent",
                    payload: { data: { text: "text-only" } },
                  }),
                ),
              );
            }
            this.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  type: "res",
                  id: request.id,
                  ok: true,
                  payload:
                    wsState.mode === "no_run_id" ? { status } : { runId: "openclaw-run", status },
                }),
              ),
            );
            return;
          }
        }
        if (request.method === "agent") {
          this.emit("message", Buffer.from("malformed event"));
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                type: "event",
                event: "agent",
                payload: { data: { delta: "hello" } },
              }),
            ),
          );
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok: true,
                payload: {
                  ...(wsState.mode === "nostatus" ||
                  wsState.mode === "final_failed" ||
                  wsState.mode === "final_cancelled"
                    ? { runId: "openclaw-run" }
                    : wsState.mode === "no_run_id"
                      ? { status: "running" }
                      : {
                          runId: "openclaw-run",
                          status: "completed",
                          ...(wsState.mode === "output"
                            ? { output: "output" }
                            : { result: "done" }),
                        }),
                },
              }),
            ),
          );
        }
      });
    }

    close() {
      this.closed = true;
      this.readyState = 3;
      this.emit("close");
    }
  }

  return { default: FakeWebSocket };
});

import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import { openclawGateway } from "@aaspai/harness";

function context(
  config: JsonObject,
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    protocolVersion: 1,
    runId: "run_openclaw",
    organizationId: "org_openclaw",
    agent: {
      id: "agent_openclaw",
      organizationId: "org_openclaw",
      name: "OpenClaw test",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    },
    runtime: {},
    config,
    context: { cwd: "C:\\work", prompt: "hello", issueId: "issue-1" },
    execution: {
      identity: { kind: "local", cwd: "C:\\work" },
      environment: { env: {}, inheritEnv: false },
      run: async (_options: RunProcessOptions): Promise<RunProcessResult> => ({
        exitCode: 0,
        signal: undefined,
        timedOut: false,
        stdout: "",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1,
        runtimeIdentity: { kind: "local", cwd: "C:\\work" },
      }),
    },
    onLog: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  wsState.mode = "success";
  wsState.instances.length = 0;
  vi.useRealTimers();
});

describe("openclaw_gateway WebSocket protocol", () => {
  it("authenticates, signs the challenge, streams an event, and issues a run session key", async () => {
    const log = vi.fn(async () => {});
    const result = await openclawGateway.execute(
      context(
        {
          url: "ws://openclaw.test",
          token: "token",
          clientId: "client",
          clientVersion: "2",
          role: "operator",
          scopes: ["operator.admin"],
          sessionKeyStrategy: "run",
          headers: { "x-test": "yes" },
          agentId: "provider-agent",
        },
        { onLog: log },
      ),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "agent:agent_openclaw:run:run_openclaw",
      sessionParams: { sessionKey: "agent:agent_openclaw:run:run_openclaw", runId: "openclaw-run" },
      summary: "done",
      provider: "openclaw",
    });
    expect(log).toHaveBeenCalledWith("stdout", expect.stringContaining("hello"));
    expect(wsState.instances).toHaveLength(1);
  });

  it("supports password-only auth and issue session strategy without device auth", async () => {
    const result = await openclawGateway.execute(
      context({
        url: "ws://openclaw.test",
        password: "password",
        disableDeviceAuth: true,
        sessionKeyStrategy: "issue",
      }),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "agent:agent_openclaw:issue:issue-1",
      summary: "done",
    });
  });

  it("uses configured session fallbacks and tolerates empty optional fields", async () => {
    const result = await openclawGateway.execute(
      context({
        url: "ws://openclaw.test",
        env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
        sessionKey: "configured-session",
        sessionKeyStrategy: "custom",
        scopes: ["", 2],
        headers: "not-an-object",
        agentId: "",
      }),
    );
    expect(result).toMatchObject({ exitCode: 0, sessionId: "configured-session" });
  });

  it("reports missing URLs, invalid device keys, connection failures, and run failures", async () => {
    await expect(openclawGateway.execute(context({}))).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_url_missing",
    });

    await expect(
      openclawGateway.execute(
        context({ url: "ws://openclaw.test", devicePrivateKeyPem: "not-a-private-key" }),
      ),
    ).resolves.toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_auth_config" });

    wsState.mode = "connect_error";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test" })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_connect_failed",
    });

    wsState.mode = "agent_error";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", disableDeviceAuth: true })),
    ).resolves.toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_run_failed" });
  });

  it("handles environment checks and pre-aborted cancellation", async () => {
    await expect(openclawGateway.testEnvironment(context({}))).resolves.toMatchObject({
      ok: false,
      checks: [{ name: "openclaw_gateway_url", level: "error" }],
    });
    await expect(
      openclawGateway.testEnvironment(context({ url: "ws://openclaw.test" })),
    ).resolves.toMatchObject({ ok: true, checks: [{ level: "info" }] });

    const controller = new AbortController();
    controller.abort();
    await expect(
      openclawGateway.execute(
        context({ url: "ws://openclaw.test" }, { signal: controller.signal }),
      ),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  it("times out connect, challenge, and agent requests and ignores malformed frames", async () => {
    wsState.mode = "connect_timeout";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", timeoutSec: 0.001 })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_connect_failed",
    });
    wsState.mode = "challenge_timeout";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", timeoutSec: 0.001 })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_connect_failed",
    });
    wsState.mode = "agent_timeout";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", timeoutSec: 0.001 })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_run_failed",
    });
    wsState.mode = "malformed";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test" })),
    ).resolves.toMatchObject({ exitCode: 0 });
    wsState.mode = "wait";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test" })),
    ).resolves.toMatchObject({ exitCode: 0, summary: "waited" });
  });

  it("covers alternate auth, session, event, and failure fields", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    await expect(
      openclawGateway.execute(
        context({
          url: "ws://openclaw.test",
          devicePrivateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        }),
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    wsState.mode = "chunk";
    await expect(
      openclawGateway.execute(
        context(
          { url: "ws://openclaw.test", sessionKeyStrategy: "unknown" },
          { context: { cwd: "C:\\work", prompt: "hello" } as never },
        ),
      ),
    ).resolves.toMatchObject({ summary: "text-only" });
    wsState.mode = "output";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", disableDeviceAuth: true })),
    ).resolves.toMatchObject({ summary: "output" });
    wsState.mode = "agent_error_no_message";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", disableDeviceAuth: true })),
    ).resolves.toMatchObject({ errorMessage: "OpenClaw request failed: agent" });
    wsState.mode = "connect_string_error";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", disableDeviceAuth: true })),
    ).resolves.toMatchObject({ errorMessage: "socket unavailable" });

    const { privateKey: rsaPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(
      openclawGateway.execute(
        context({
          url: "ws://openclaw.test",
          devicePrivateKeyPem: rsaPrivateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        }),
      ),
    ).resolves.toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_connect_failed" });
    wsState.mode = "nostatus";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", disableDeviceAuth: true })),
    ).resolves.toMatchObject({ summary: "waited" });
    wsState.mode = "final_failed";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", disableDeviceAuth: true })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorMessage: "OpenClaw run failed",
      errorCode: "openclaw_gateway_run_failed",
    });
    wsState.mode = "no_run_id";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", disableDeviceAuth: true })),
    ).resolves.toMatchObject({ sessionParams: { runId: "run_openclaw" } });
    wsState.mode = "final_cancelled";
    await expect(
      openclawGateway.execute(context({ url: "ws://openclaw.test", disableDeviceAuth: true })),
    ).resolves.toMatchObject({ exitCode: 1, signal: "SIGTERM" });

    const badConfig = {
      url: "ws://openclaw.test",
      get devicePrivateKeyPem(): never {
        throw "bad device key";
      },
    };
    await expect(openclawGateway.execute(context(badConfig))).resolves.toMatchObject({
      errorCode: "openclaw_gateway_auth_config",
      errorMessage: "bad device key",
    });
  });
});
