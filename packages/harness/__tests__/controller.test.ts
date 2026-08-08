import {
  type AdapterExecutionContext,
  HARNESS_PROTOCOL_VERSION,
  type ServerAdapterModule,
} from "@aaspai/contracts/harness";
import { describe, expect, it } from "vitest";
import { HarnessController } from "../src/control/controller.js";

function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    runId: "ignored",
    organizationId: "org_1",
    agent: {
      id: "agent_1",
      organizationId: "org_1",
      name: "Test",
      adapterType: "opencode_local",
      adapterConfig: {},
    },
    runtime: {},
    config: {},
    context: { cwd: process.cwd(), prompt: "hello" },
    execution: {
      run: async () => ({
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
      }),
    },
    onLog: () => undefined,
    ...overrides,
  } as AdapterExecutionContext;
}

function adapter(execute: ServerAdapterModule["execute"]): ServerAdapterModule {
  return {
    info: {
      type: "opencode_local",
      label: "Test OpenCode",
      transport: "local_subprocess",
      models: [],
      agentConfigurationDoc: "",
      status: "ready",
    },
    execute,
    testEnvironment: async () => ({ ok: true, checks: [] }),
    cancel: async ({ sessionId }) => ({ cancelled: true, sessionId, finalStatus: "cancelled" }),
  };
}

describe("HarnessController", () => {
  it("owns lifecycle and provider session identity", async () => {
    const controller = new HarnessController();
    const events: string[] = [];
    const handle = controller.start({
      executionId: "exec_identity",
      adapter: adapter(async (ctx) => {
        await ctx.onEvent?.({
          type: "native.session",
          timestamp: new Date().toISOString(),
          nativeSessionId: "ses_native",
        });
        return {
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          exitCode: 0,
          timedOut: false,
          usageBasis: "per_run",
          clearSession: false,
          sessionId: "ses_native",
        };
      }),
      context: context(),
    });
    handle.subscribe((event) => events.push(event.type));
    await handle.done;
    expect(handle.snapshot()).toMatchObject({
      state: "completed",
      providerSessionId: "ses_native",
    });
    expect(events).toContain("provider.event");
    expect(events).toContain("result");
  });

  it("pauses for a question and resumes only after the controller answers", async () => {
    const controller = new HarnessController();
    const handle = controller.start({
      executionId: "exec_question",
      adapter: adapter(async (ctx) => {
        const answer = await ctx.onQuestion?.({ prompt: "Continue?", options: ["yes", "no"] });
        return {
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          exitCode: answer === "yes" ? 0 : 1,
          timedOut: false,
          usageBasis: "per_run",
          clearSession: false,
          ...(answer ? { summary: answer } : {}),
        };
      }),
      context: context(),
    });
    await new Promise<void>((resolve) => {
      const unsubscribe = handle.subscribe((event) => {
        if (event.type === "question") {
          unsubscribe();
          resolve();
        }
      });
    });
    expect(handle.snapshot().state).toBe("waiting_for_question");
    expect(handle.answerQuestion("yes")).toBe(true);
    await handle.done;
    expect(handle.snapshot().state).toBe("completed");
  });

  it("cancels before a provider session exists", async () => {
    const controller = new HarnessController();
    const handle = controller.start({
      executionId: "exec_cancel",
      adapter: adapter(
        (ctx) =>
          new Promise((resolve) => {
            ctx.signal?.addEventListener("abort", () =>
              resolve({
                protocolVersion: HARNESS_PROTOCOL_VERSION,
                exitCode: null,
                timedOut: false,
                usageBasis: "per_run",
                clearSession: false,
              }),
            );
          }),
      ),
      context: context(),
    });
    expect(await handle.cancel()).toBe(true);
    await handle.done;
    expect(handle.snapshot().state).toBe("cancelled");
  });
});
