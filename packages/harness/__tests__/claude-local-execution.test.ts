import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import { describe, expect, it, vi } from "vitest";
import { execute } from "../src/drivers/claude-local/execute";

describe("claude_local runtime execution", () => {
  it("frames JSON events split across runtime log chunks", async () => {
    const runtimeRun = vi.fn<NonNullable<AdapterExecutionContext["execution"]>["run"]>(
      async (options) => {
        await options.onLog?.("stdout", '{"type":"assistant","message":{"content":[');
        await options.onLog?.("stdout", '{"type":"text","text":"split"}]}}\n');
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
    const result = await execute({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_split",
      organizationId: "org_test",
      agent: {
        id: "agent_claude",
        organizationId: "org_test",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: { cwd: "/workspace", prompt: "test" },
      execution: { run: runtimeRun },
      onLog: () => undefined,
    });

    expect(result.summary).toBe("split");
  });

  it("uses the managed runtime process boundary when provided", async () => {
    const runtimeRun = vi.fn<NonNullable<AdapterExecutionContext["execution"]>["run"]>(
      async (options) => {
        await options.onLog?.(
          "stdout",
          `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "managed" }] } })}\n`,
        );
        const now = new Date().toISOString();
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          runtimeIdentity: { kind: "docker", cwd: "/workspace", containerId: "container-1" },
        };
      },
    );
    const result = await execute({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_managed",
      organizationId: "org_test",
      agent: {
        id: "agent_claude",
        organizationId: "org_test",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {},
      config: { command: "must-not-run-on-worker-host" },
      context: { cwd: "/workspace", prompt: "test" },
      execution: {
        identity: { kind: "docker", cwd: "/workspace" },
        run: runtimeRun,
      },
      onLog: () => undefined,
    });

    expect(runtimeRun).toHaveBeenCalledOnce();
    expect(runtimeRun.mock.calls[0]?.[0]).toMatchObject({
      command: "must-not-run-on-worker-host",
      cwd: "/workspace",
      stdin: "test",
    });
    expect(result.exitCode).toBe(0);
  });
});
