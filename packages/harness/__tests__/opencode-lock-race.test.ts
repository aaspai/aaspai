import { randomUUID } from "node:crypto";
import { closeSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("OpenCode lock race", () => {
  it("retries a create race that reports EEXIST", async () => {
    vi.resetModules();
    const lockPath = join(tmpdir(), `aaspai-opencode-race-${randomUUID()}.lock`);
    process.env.AASPAI_OPENCODE_LOCK_PATH = lockPath;
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let raced = true;
    vi.doMock("node:fs", () => ({
      ...actual,
      existsSync: (path: string) => (raced && path === lockPath ? false : actual.existsSync(path)),
      openSync: (path: string, flags: string) => {
        if (raced && path === lockPath && flags === "wx") {
          raced = false;
          const fd = actual.openSync(path, "w");
          writeSync(fd, `${process.pid}@race@owner`);
          closeSync(fd);
          throw Object.assign(new Error("already exists"), { code: "EEXIST" });
        }
        return actual.openSync(path, flags);
      },
    }));
    try {
      const { opencodeCli } = await import("../src/drivers/opencode-cli/implementation.js");
      await expect(
        opencodeCli.execute({
          protocolVersion: 1,
          runId: "run-lock-race",
          organizationId: "org-lock-race",
          agent: {
            id: "agent/lock-race",
            organizationId: "org-lock-race",
            name: "Lock",
            adapterType: "opencode_cli",
            adapterConfig: {},
          },
          runtime: {},
          config: { command: "runtime-opencode" },
          context: { cwd: process.cwd(), prompt: "lock race" },
          execution: {
            run: async () => ({
              exitCode: 0,
              timedOut: false,
              stdout: "",
              stderr: "",
              startedAt: "",
              finishedAt: "",
              durationMs: 1,
            }),
          },
          onLog: async () => undefined,
        } as never),
      ).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      delete process.env.AASPAI_OPENCODE_LOCK_PATH;
      rmSync(lockPath, { force: true });
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("times out a lock whose owner record is malformed", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const lockPath = join(tmpdir(), `aaspai-opencode-malformed-${randomUUID()}.lock`);
    process.env.AASPAI_OPENCODE_LOCK_PATH = lockPath;
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    actual.writeFileSync(lockPath, "malformed-owner");
    try {
      const { opencodeCli } = await import("../src/drivers/opencode-cli/implementation.js");
      const pending = opencodeCli.execute({
        protocolVersion: 1,
        runId: "run-lock-malformed",
        organizationId: "org-lock-malformed",
        agent: {
          id: "agent/lock-malformed",
          organizationId: "org-lock-malformed",
          name: "Lock",
          adapterType: "opencode_cli",
          adapterConfig: {},
        },
        runtime: {},
        config: { command: "runtime-opencode" },
        context: { cwd: process.cwd(), prompt: "lock malformed" },
        onLog: async () => undefined,
      } as never);
      const rejection = expect(pending).rejects.toThrow("cross-process lock timeout");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_100);
      await rejection;
    } finally {
      delete process.env.AASPAI_OPENCODE_LOCK_PATH;
      actual.rmSync(lockPath, { force: true });
      vi.useRealTimers();
      vi.resetModules();
    }
  }, 15_000);
});
