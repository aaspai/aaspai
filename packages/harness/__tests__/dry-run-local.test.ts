import { describe, expect, it } from "vitest";
import { dryRunLocal, dryRunLocalInfo } from "../src/drivers/dry-run-local/index.js";

describe("dry_run_local adapter", () => {
  it("declares itself ready and uses no API key", () => {
    expect(dryRunLocalInfo.type).toBe("dry_run_local");
    expect(dryRunLocalInfo.status).toBe("ready");
    expect(dryRunLocalInfo.transport).toBe("local_subprocess");
  });

  it("synthesizes a plan from the prompt", async () => {
    const onLog = async (_stream: "stdout" | "stderr", _chunk: string) => {};
    const result = await dryRunLocal.execute({
      protocolVersion: 1 as const,
      runId: "run_1",
      organizationId: "default",
      agent: {
        id: "agent/operator",
        organizationId: "default",
        name: "Operator",
        adapterType: "dry_run_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: { cwd: "/tmp", prompt: "Review the auth middleware" },
      onLog,
      onMeta: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toMatch(/^dry_/);
    expect(result.summary).toContain("Plan");
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBe(0);
  });

  it("testEnvironment always returns ok", async () => {
    const result = await dryRunLocal.testEnvironment({ config: {}, cwd: "/tmp" });
    expect(result.ok).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
  });
});
