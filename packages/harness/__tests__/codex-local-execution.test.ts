import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import { describe, expect, it, vi } from "vitest";
import { execute } from "../src/drivers/codex-local/execute";

function context(
  run: NonNullable<AdapterExecutionContext["execution"]>["run"],
  config: AdapterExecutionContext["config"] = {},
): AdapterExecutionContext {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    runId: "run_codex_test",
    organizationId: "org_test",
    agent: {
      id: "agent_codex",
      organizationId: "org_test",
      name: "Codex",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {},
    config,
    context: { cwd: "/workspace", prompt: "test" },
    execution: { run },
    onLog: () => undefined,
  };
}

describe("codex_local runtime execution", () => {
  it("frames split JSONL events and forwards the configured grace period", async () => {
    const runtimeRun = vi.fn<NonNullable<AdapterExecutionContext["execution"]>["run"]>(
      async (options) => {
        await options.onLog?.("stdout", '{"type":"item.completed","item":');
        await options.onLog?.("stdout", '{"type":"agent_message","text":"split"}}\n');
        const now = new Date().toISOString();
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
        };
      },
    );

    const result = await execute(context(runtimeRun, { outputInactivityTimeoutMs: 1_000 }));

    expect(runtimeRun.mock.calls[0]?.[0].graceMs).toBe(15_000);
    expect(result.summary).toBe("split");
  });

  it("turns an output-inactivity abort into a timed-out result", async () => {
    const runtimeRun = vi.fn<NonNullable<AdapterExecutionContext["execution"]>["run"]>(
      (options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener("abort", () => {
            const now = new Date().toISOString();
            resolve({
              exitCode: null,
              signal: "SIGTERM",
              timedOut: false,
              stdout: "",
              stderr: "",
              startedAt: now,
              finishedAt: now,
              durationMs: 1,
            });
          });
        }),
    );

    const result = await execute(context(runtimeRun, { outputInactivityTimeoutMs: 10 }));

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("No Codex output");
  });
});
