import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("opencode process cleanup seams", () => {
  it("exercises timeout escalation and child stream cleanup listeners", async () => {
    vi.resetModules();
    let pid = 10_000;
    const spawn = vi.fn((_command: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
        kill: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      };
      child.pid = pid++;
      if (_command === "serve-no-pid.cmd" || _command === "acp-no-pid")
        child.pid = undefined as never;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
      child.stdin.end = vi.fn();
      child.stdout.on("error", () => undefined);
      child.stderr.on("error", () => undefined);
      child.kill = vi.fn((signal: string) => {
        if (_command === "error-after-timeout" && signal === "SIGTERM")
          queueMicrotask(() => child.emit("error", new Error("child failed")));
        else if (signal === "SIGKILL" || (signal === "SIGTERM" && args.includes("acp")))
          queueMicrotask(() => child.emit("close", null, signal));
      });
      child.unref = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit("error", new Error("stdout closed"));
        child.stderr.emit("error", new Error("stderr closed"));
        child.stderr.emit("data", Buffer.from("   \n"));
        child.stderr.emit("data", Buffer.from("first diagnostic\n"));
        child.stderr.emit("data", Buffer.from("   \n"));
        if (_command.endsWith(".cmd")) {
          child.stdout.emit(
            "data",
            Buffer.from(
              _command === "serve-invalid.cmd"
                ? "server ready\n"
                : _command === "serve-no-port.cmd"
                  ? "listening on http://localhost\n"
                  : "listening on http://127.0.0.1:4321\n",
            ),
          );
        } else if (_command === "child-error") {
          child.emit("error", new Error("spawned child failed"));
        } else if (args.includes("session") && args.includes("import")) {
          child.stdin.on("error", () => undefined);
          child.stdin.emit("error", new Error("stdin closed"));
          child.stdout.emit("data", Buffer.from("ses-imported\n"));
          child.emit("close", 0, null);
        } else if (!args.includes("run") && !args.includes("acp")) {
          child.stdout.emit("data", Buffer.from("agent\n"));
          child.emit("close", 0, null);
        }
      });
      return child;
    });
    vi.doMock("node:child_process", () => ({ spawn, execFile: vi.fn() }));
    try {
      const {
        listOpencodeAgents,
        opencodeCli,
        opencodeSessionImport,
        startOpencodeAcp,
        startOpencodeServe,
        stopOpencodeAcp,
        stopOpencodeServe,
      } = await import("../src/drivers/opencode-cli/implementation.js");
      process.env.AASPAI_OPENCODE_LOCK_PATH = join(
        tmpdir(),
        `aaspai-opencode-seam-${randomUUID()}.lock`,
      );
      const result = await opencodeCli.execute({
        protocolVersion: 1,
        runId: "run-process-seam",
        organizationId: "org-seam",
        agent: {
          id: "agent/seam",
          organizationId: "org-seam",
          name: "Seam",
          adapterType: "opencode_cli",
          adapterConfig: {},
        },
        runtime: {},
        config: { command: "fake-opencode", timeoutSec: 0.001, graceSec: 0.001 },
        context: { cwd: process.cwd(), prompt: "timeout" },
        onLog: async () => undefined,
      } as never);
      expect(result).toMatchObject({ timedOut: true, errorCode: "timeout" });
      await expect(
        opencodeCli.execute({
          protocolVersion: 1,
          runId: "run-process-error-after-timeout",
          organizationId: "org-seam",
          agent: {
            id: "agent/seam",
            organizationId: "org-seam",
            name: "Seam",
            adapterType: "opencode_cli",
            adapterConfig: {},
          },
          runtime: {},
          config: { command: "error-after-timeout", timeoutSec: 0.001, graceSec: 0.001 },
          context: { cwd: process.cwd(), prompt: "error" },
          onLog: async () => undefined,
        } as never),
      ).rejects.toThrow("child failed");
      await expect(
        opencodeCli.execute({
          protocolVersion: 1,
          runId: "run-process-child-error",
          organizationId: "org-seam",
          agent: {
            id: "agent/seam",
            organizationId: "org-seam",
            name: "Seam",
            adapterType: "opencode_cli",
            adapterConfig: {},
          },
          runtime: {},
          config: { command: "child-error", timeoutSec: 10 },
          context: { cwd: process.cwd(), prompt: "error" },
          onLog: async () => undefined,
        } as never),
      ).rejects.toThrow("spawned child failed");
      await expect(opencodeSessionImport("{}", { cli: "fake-opencode" })).resolves.toBe(
        "ses-imported",
      );
      await expect(listOpencodeAgents({ cli: "fake-opencode" })).resolves.toMatchObject({
        rows: ["agent"],
      });
      const acp = await startOpencodeAcp({ cli: "fake-opencode", workspaceKey: "seam-acp" });
      expect(stopOpencodeAcp("seam-acp")).toBe(true);
      await expect(acp.stopped).resolves.toEqual({ exitCode: null });
      const serve = await startOpencodeServe({
        cli: "fake-opencode.cmd",
        workspaceKey: "seam-serve",
      });
      expect(serve).toMatchObject({ url: "http://127.0.0.1:4321", port: 4321 });
      stopOpencodeServe("seam-serve");
      const noPortServe = await startOpencodeServe({
        cli: "serve-no-port.cmd",
        workspaceKey: "seam-serve-no-port",
      });
      expect(noPortServe).toMatchObject({ port: 0 });
      stopOpencodeServe("seam-serve-no-port");
      const noPidServe = await startOpencodeServe({
        cli: "serve-no-pid.cmd",
        workspaceKey: "seam-serve-no-pid",
      });
      expect(noPidServe.pid).toBe(0);
      stopOpencodeServe("seam-serve-no-pid");
      vi.useFakeTimers();
      const invalidServe = startOpencodeServe({
        cli: "serve-invalid.cmd",
        workspaceKey: "seam-serve-invalid",
      });
      const invalidFailure = expect(invalidServe).rejects.toThrow("startup timeout");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_001);
      await invalidFailure;
      vi.useRealTimers();
      const noKeyAcp = await startOpencodeAcp({ cli: "acp-no-pid" });
      expect(noKeyAcp.pid).toBe(-1);
      expect(stopOpencodeAcp()).toBe(true);
      await expect(noKeyAcp.stopped).resolves.toEqual({ exitCode: null });
      expect(spawn).toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  }, 10_000);
});
