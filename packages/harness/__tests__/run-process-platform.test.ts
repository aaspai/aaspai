import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("runProcess platform resolution edges", () => {
  it("covers non-Windows resolution and both pid termination branches", async () => {
    const originalPlatform = process.platform;
    const spawned: Array<{ pid?: number; kill: ReturnType<typeof vi.fn> }> = [];
    const spawnMock = vi.fn((_command: string, _args: readonly string[], _options: unknown) => {
      const child = new EventEmitter() as EventEmitter & {
        pid?: number;
        stdin: null;
        stdout: null;
        stderr: null;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = null;
      child.stdout = null;
      child.stderr = null;
      child.kill = vi.fn();
      child.pid = spawned.length === 0 ? undefined : 321;
      spawned.push(child);
      setTimeout(() => child.emit("close", null, null), spawned.length === 3 ? 50 : 10);
      return child;
    });

    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    try {
      Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
      const { runProcess } = await import("../src/shared/run-process");
      const first = new AbortController();
      first.abort();
      await expect(
        runProcess({ command: "node", args: [], signal: first.signal, graceMs: 1 }),
      ).resolves.toMatchObject({
        exitCode: null,
        timedOut: false,
      });

      const second = new AbortController();
      const secondRun = runProcess({
        command: "node",
        args: [],
        signal: second.signal,
        graceMs: 1,
      });
      setTimeout(() => second.abort(), 2);
      await expect(secondRun).resolves.toMatchObject({ exitCode: null });
      expect(spawned[0]?.kill).toHaveBeenCalled();

      const third = new AbortController();
      const thirdRun = runProcess({
        command: "node",
        args: [],
        signal: third.signal,
        timeoutMs: 1,
        graceMs: 1,
      });
      setTimeout(() => third.abort(), 10);
      await expect(thirdRun).resolves.toMatchObject({ exitCode: null, timedOut: true });

      const directory = join(tmpdir(), `aaspai-run-platform-${process.pid}`);
      await mkdir(directory, { recursive: true });
      const shim = join(directory, "edge.cmd");
      await writeFile(shim, "@echo off\r\nno static target\r\n");
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      await expect(
        runProcess({
          command: "edge",
          args: [],
          env: { Path: directory, AASPAI_RUN_SKIP_CMD_RESOLUTION: "1" },
        }),
      ).resolves.toMatchObject({ exitCode: null });
      await expect(
        runProcess({ command: "edge", args: [], inheritEnv: false }),
      ).resolves.toMatchObject({ exitCode: null });
      await expect(runProcess({ command: shim, args: [] })).resolves.toMatchObject({
        exitCode: null,
      });
      await expect(
        runProcess({ command: "edge", args: [], env: { PATH: directory }, inheritEnv: false }),
      ).resolves.toMatchObject({ exitCode: null });
      await expect(
        runProcess({ command: shim, args: [], inheritEnv: false }),
      ).resolves.toMatchObject({ exitCode: null });
      const jsShim = join(directory, "js-edge.cmd");
      await writeFile(jsShim, '"%dp0%\\package\\cli.js" %*\r\n');
      await expect(runProcess({ command: jsShim, args: ["arg"] })).resolves.toMatchObject({
        exitCode: null,
      });
      const exeShim = join(directory, "exe-edge.cmd");
      await writeFile(exeShim, '"%dp0%\\package\\cli.exe" %*\r\n');
      await expect(runProcess({ command: exeShim, args: ["arg"] })).resolves.toMatchObject({
        exitCode: null,
      });
      await rm(directory, { recursive: true, force: true });
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});
