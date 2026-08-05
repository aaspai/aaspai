import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import { cursorCloud, hermesGateway } from "@aaspai/harness";
import { afterEach, describe, expect, it, vi } from "vitest";

function processResult(): RunProcessResult {
  return {
    exitCode: 0,
    signal: undefined,
    timedOut: false,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    runtimeIdentity: { kind: "local", cwd: "C:\\work" },
  };
}

function context(
  config: JsonObject,
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    protocolVersion: 1,
    runId: "run_gateway",
    organizationId: "org_gateway",
    agent: {
      id: "agent_gateway",
      organizationId: "org_gateway",
      name: "Gateway test",
      adapterType: "cursor_cloud",
      adapterConfig: {},
    },
    runtime: {},
    config,
    context: { cwd: "C:\\work", prompt: "hello", issueId: "issue-1" },
    execution: {
      identity: { kind: "local", cwd: "C:\\work" },
      environment: { env: {}, inheritEnv: false },
      run: async (_options: RunProcessOptions) => processResult(),
    },
    onLog: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cursor_cloud transport", () => {
  it("posts a request, preserves session state, and completes immediately", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            agentId: "cursor-agent",
            status: "completed",
            result: "cloud result",
            runId: "cursor-run",
            model: "composer-1.5",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const log = vi.fn(async () => {});
    const result = await cursorCloud.execute(
      context(
        {
          apiKey: "key",
          endpoint: "https://cursor.test/agents/",
          model: "composer-1.5",
          repositoryUrl: "https://github.test/repo",
          startingRef: "main",
        },
        {
          runtime: { sessionParams: { cursorAgentId: "previous-agent" } },
          onLog: log,
        },
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toMatchObject({
      prompt: "hello",
      model: "composer-1.5",
      repository: "https://github.test/repo",
      startingRef: "main",
      agentId: "previous-agent",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "cursor-agent",
      sessionParams: { cursorAgentId: "cursor-agent", latestRunId: "cursor-run" },
      summary: "cloud result",
      model: "composer-1.5",
      billingType: "api",
      provider: "cursor",
    });
    expect(log).toHaveBeenCalled();
  });

  it("accepts credentials from env and returns HTTP failures", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream failed", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cursorCloud.execute(
      context({ env: { CURSOR_API_KEY: "key" }, timeoutSec: 1 }),
    );

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "cursor_cloud_failed",
      errorFamily: "transient_upstream",
      errorMessage: "Cursor Cloud HTTP 503",
    });
  });

  it("polls a running cloud agent and emits deltas", async () => {
    const log = vi.fn(async () => {});
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? new Response(JSON.stringify({ agentId: "agent", status: "running" }), { status: 200 })
          : new Response(
              JSON.stringify({
                status: "completed",
                delta: "delta",
                result: "finished",
                run_id: "run",
              }),
              { status: 200 },
            );
      }),
    );

    const result = await cursorCloud.execute(context({ apiKey: "key" }, { onLog: log }));
    expect(result).toMatchObject({ exitCode: 0, summary: "finished", sessionId: "agent" });
    expect(log).toHaveBeenCalledWith("stdout", expect.stringContaining("delta"));
  });

  it("normalizes thrown transport failures and supports environment checks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(cursorCloud.execute(context({ apiKey: "key" }))).resolves.toMatchObject({
      exitCode: 1,
      errorMessage: "network down",
    });
    await expect(cursorCloud.testEnvironment(context({}))).resolves.toMatchObject({
      ok: false,
      checks: [{ name: "cursor_cloud_auth", level: "error" }],
    });
    await expect(cursorCloud.testEnvironment(context({ apiKey: "key" }))).resolves.toMatchObject({
      ok: true,
      checks: [{ level: "info" }],
    });
  });

  it("honors a pre-aborted cloud request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "completed", result: "done" }), { status: 200 }),
      ),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      cursorCloud.execute(context({ apiKey: "key" }, { signal: controller.signal })),
    ).resolves.toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("does not poll an already terminal cloud run", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            agentId: "terminal",
            statusUrl: "https://cursor.test/terminal",
            result: "done",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(cursorCloud.execute(context({ apiKey: "key" }))).resolves.toMatchObject({
      exitCode: 0,
      sessionId: "terminal",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles protocol responses without an agent id and failed terminal runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(
      cursorCloud.execute(context({ apiKey: "key", model: "", endpoint: "https://cursor.test/" })),
    ).resolves.toMatchObject({
      exitCode: 0,
      summary: "not-json",
      sessionParams: undefined,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ agent_id: "agent", status: "failed", message: "failed" }), {
            status: 200,
          }),
      ),
    );
    await expect(
      cursorCloud.execute(context({ env: { CURSOR_API_KEY: "key" } })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "cursor_cloud_run_failed",
      errorMessage: "failed",
    });
  });

  it("aborts an in-flight cloud request at the configured timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), {
              once: true,
            });
          }),
      ),
    );
    await expect(
      cursorCloud.execute(context({ apiKey: "key", timeoutSec: 0.001 })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorMessage: "request timed out",
    });
  });

  it("accepts alternate agent/status/result fields", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call += 1;
        if (call === 1)
          return new Response(
            JSON.stringify({
              agent_id: "agent-alt",
              status: "running",
              status_url: "https://cursor.test/status",
            }),
            { status: 200 },
          );
        if (url.endsWith("/status"))
          return new Response(
            JSON.stringify({ status: "completed", message: "message result", run_id: "run-alt" }),
            { status: 200 },
          );
        return new Response(
          JSON.stringify({ id: "agent-id", status: "completed", output: "output result" }),
          { status: 200 },
        );
      }),
    );
    await expect(cursorCloud.execute(context({ apiKey: "key" }))).resolves.toMatchObject({
      sessionId: "agent-alt",
      summary: "message result",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ id: "agent-id", status: "completed", output: "output result" }),
            { status: 200 },
          ),
      ),
    );
    await expect(cursorCloud.execute(context({ apiKey: "key" }))).resolves.toMatchObject({
      sessionId: "agent-id",
      summary: "output result",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/agents")) return new Response("", { status: 200 });
        return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
      }),
    );
    await expect(
      cursorCloud.execute(context({ apiKey: "key", endpoint: "https://cursor.test/agents" })),
    ).resolves.toMatchObject({ summary: "Cursor Cloud completed" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/agents"))
          return new Response(JSON.stringify({ agentId: "agent-no-delta", status: "running" }), {
            status: 200,
          });
        return new Response(
          JSON.stringify({ status: "completed", output: "completed without delta" }),
          { status: 200 },
        );
      }),
    );
    await expect(
      cursorCloud.execute(context({ apiKey: "key", endpoint: "https://cursor.test/agents" })),
    ).resolves.toMatchObject({ summary: "completed without delta" });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "agent-terminal",
              status: "completed",
              status_url: "https://cursor.test/status",
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(cursorCloud.execute(context({ apiKey: "key" }))).resolves.toMatchObject({
      sessionId: "agent-terminal",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "string transport failure";
      }),
    );
    await expect(cursorCloud.execute(context({ apiKey: "key" }))).resolves.toMatchObject({
      errorMessage: "string transport failure",
    });
  });
});

describe("hermes_gateway transport", () => {
  it("returns HTTP and protocol failures before opening an event stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 })),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test", apiKey: "key" })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "hermes_gateway_failed",
      errorMessage: "bad request",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "running" }), { status: 200 })),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "hermes_gateway_protocol_error",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "hermes_gateway_protocol_error",
    });
  });

  it("consumes SSE deltas, ignores malformed frames, and returns terminal state", async () => {
    const encoder = new TextEncoder();
    const makeStream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `${[
                "event: delta",
                'data: {"delta":"hello"}',
                "",
                "event: bad",
                "data: not-json",
                "",
                "event: done",
                'data: {"status":"completed","output":"done","session_id":"hermes-session","model":"auto"}',
                "",
              ].join("\n")}\n`,
            ),
          );
          controller.close();
        },
      });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "hermes-run", status: "running" }), {
          status: 200,
        });
      }
      if (url.endsWith("/events")) {
        return new Response(makeStream(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          output: "done",
          session_id: "hermes-session",
          model: "auto",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.fn(async () => {});

    const result = await hermesGateway.execute(
      context(
        { baseUrl: "http://hermes.test/", model: "auto", sessionKey: "session-key" },
        { onLog: log, runtime: { sessionParams: { hermesSessionId: "old-session" } } },
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toMatchObject({
      prompt: "hello",
      model: "auto",
      session_id: "old-session",
      session_key: "session-key",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "hermes-session",
      sessionParams: { hermesRunId: "hermes-run", hermesSessionId: "hermes-session" },
      summary: "done",
      model: "auto",
    });
    expect(log).toHaveBeenCalledWith("stdout", expect.stringContaining("hello"));
    expect(log).toHaveBeenCalledWith("stderr", expect.stringContaining("ignored malformed SSE"));
  });

  it("falls back from an unavailable SSE stream to polling", async () => {
    let call = 0;
    const log = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1)
          return new Response(JSON.stringify({ run_id: "poll-run", status: "running" }), {
            status: 200,
          });
        if (call === 2) throw new Error("SSE unavailable");
        return new Response(
          JSON.stringify({ status: "completed", delta: "polled", output: "poll result" }),
          { status: 200 },
        );
      }),
    );

    const result = await hermesGateway.execute(
      context({ baseUrl: "http://hermes.test" }, { onLog: log }),
    );
    expect(result).toMatchObject({ exitCode: 0, summary: "poll result" });
    expect(log).toHaveBeenCalledWith("stderr", expect.stringContaining("falling back to polling"));
    expect(log).toHaveBeenCalledWith("stdout", expect.stringContaining("polled"));
  });

  it("polls after a finite non-terminal SSE stream and normalizes thrown requests", async () => {
    const encoder = new TextEncoder();
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => {
        call += 1;
        if (call === 1)
          return new Response(JSON.stringify({ run_id: "finite-run", status: "running" }), {
            status: 200,
          });
        if (call === 2) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"delta":"partial"}\n\n'));
              controller.close();
            },
          });
          return new Response(body, { status: 200 });
        }
        return new Response(JSON.stringify({ status: "completed", output: "finite result" }), {
          status: 200,
        });
      }),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({ exitCode: 0, summary: "finite result" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("gateway down");
      }),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({ errorMessage: "gateway down" });
  });

  it("falls back when the SSE endpoint is unavailable", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1)
          return new Response(JSON.stringify({ run_id: "unavailable-sse", status: "running" }), {
            status: 200,
          });
        if (call === 2) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ status: "completed", output: "polled after 503" }), {
          status: 200,
        });
      }),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({
      exitCode: 0,
      summary: "polled after 503",
    });
  });

  it("fires the gateway hard timeout while polling", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call += 1;
        if (call === 1)
          return new Response(JSON.stringify({ run_id: "timeout-run", status: "running" }), {
            status: 200,
          });
        if (url.endsWith("/events"))
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      }),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test", timeoutSec: 0.001 })),
    ).resolves.toMatchObject({
      timedOut: true,
    });
  });

  it("invokes the gateway timeout callback under deterministic timers", async () => {
    vi.useFakeTimers();
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call += 1;
        if (call === 1)
          return new Response(JSON.stringify({ run_id: "timer-run", status: "running" }), {
            status: 200,
          });
        if (url.endsWith("/events"))
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      }),
    );
    const pending = hermesGateway.execute(
      context({ baseUrl: "http://hermes.test", timeoutSec: 0.001 }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ timedOut: true });
    vi.useRealTimers();
  });

  it("stops an active gateway run when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith("/v1/runs"))
          return new Response(JSON.stringify({ run_id: "aborted-run", status: "running" }), {
            status: 200,
          });
        throw new Error("stop unavailable");
      }),
    );

    await expect(
      hermesGateway.execute(
        context({ baseUrl: "http://hermes.test" }, { signal: controller.signal }),
      ),
    ).resolves.toMatchObject({ exitCode: 1, signal: "SIGTERM" });
    expect(calls.at(-1)).toContain("/stop");
  });

  it("checks gateway health and reports fetch failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    await expect(
      hermesGateway.testEnvironment(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({ ok: true, checks: [{ name: "hermes_gateway", level: "info" }] });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unreachable");
      }),
    );
    await expect(
      hermesGateway.testEnvironment(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({ ok: false, checks: [{ level: "error", message: "unreachable" }] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "string health failure";
      }),
    );
    await expect(hermesGateway.testEnvironment(context({}))).resolves.toMatchObject({
      ok: false,
      checks: [{ message: "string health failure" }],
    });
  });

  it("covers Hermes alternate fields, terminal fallbacks, and diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 502 })),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({
      errorMessage: "Hermes Gateway HTTP 502",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/runs"))
          return new Response(
            JSON.stringify({ id: "id-run", status: "completed", result: "result output" }),
            { status: 200 },
          );
        return new Response("unexpected", { status: 500 });
      }),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test", model: "configured" })),
    ).resolves.toMatchObject({
      exitCode: 0,
      sessionParams: { hermesRunId: "id-run" },
      summary: "result output",
      model: "configured",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ run_id: "failed-run", status: "failed" }), { status: 200 }),
      ),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "hermes_gateway_run_failed",
      errorMessage: "Hermes run failed",
    });

    const encoder = new TextEncoder();
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call += 1;
        if (call === 1)
          return new Response(JSON.stringify({ runId: "alt-run", status: "running" }), {
            status: 200,
          });
        if (url.endsWith("/events")) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: not-json\n\n"));
              controller.close();
            },
          });
          return new Response(body, { status: 200 });
        }
        return new Response(JSON.stringify({ status: "completed", delta: "delta only" }), {
          status: 200,
        });
      }),
    );
    const logs = vi.fn(async () => {});
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test" }, { onLog: logs })),
    ).resolves.toMatchObject({ summary: "delta only" });
    expect(logs).toHaveBeenCalledWith("stderr", expect.stringContaining("message"));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "string failure";
      }),
    );
    await expect(
      hermesGateway.execute(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({ errorMessage: "string failure" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    await expect(
      hermesGateway.testEnvironment(context({ baseUrl: "http://hermes.test" })),
    ).resolves.toMatchObject({ ok: false });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) return new Response("down", { status: 503 });
        if (url.endsWith("/v1/runs"))
          return new Response(JSON.stringify({ run_id: "missing-status", output: "done" }), {
            status: 200,
          });
        return new Response(JSON.stringify({ output: "polled" }), { status: 200 });
      }),
    );
    await expect(hermesGateway.execute(context({ timeoutSec: 0.001 }))).resolves.toMatchObject({
      summary: expect.any(String),
    });

    let abortExternal!: () => void;
    const controller = new AbortController();
    abortExternal = () => controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/runs"))
          return new Response(JSON.stringify({ run_id: "abort-sse", status: "running" }), {
            status: 200,
          });
        if (url.endsWith("/events")) {
          abortExternal();
          throw new Error("events aborted");
        }
        return new Response("stopped", { status: 200 });
      }),
    );
    await expect(
      hermesGateway.execute(context({}, { signal: controller.signal })),
    ).resolves.toMatchObject({ exitCode: 1 });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/runs"))
          return new Response(JSON.stringify({ run_id: "string-sse", status: "running" }), {
            status: 200,
          });
        if (url.endsWith("/events")) throw "string SSE failure";
        return new Response(JSON.stringify({ status: "completed", output: "poll" }), {
          status: 200,
        });
      }),
    );
    const stringLogs = vi.fn(async () => {});
    await expect(hermesGateway.execute(context({}, { onLog: stringLogs }))).resolves.toMatchObject({
      summary: "poll",
    });
    expect(stringLogs).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("string SSE failure"),
    );
  });
});
