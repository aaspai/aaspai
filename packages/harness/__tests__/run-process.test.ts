import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJsonlFramer } from "../src/shared/jsonl";
import { runProcess } from "../src/shared/run-process";

describe("JSONL framing", () => {
  it("keeps partial lines until the next chunk or flush", () => {
    const framer = createJsonlFramer();
    expect(framer.push('{"a":1')).toEqual([]);
    expect(framer.push('}\r\n{"b":2')).toEqual(['{"a":1}']);
    expect(framer.flush()).toEqual(['{"b":2']);
  });
});

describe("runProcess cancellation", () => {
  it("waits for asynchronous log listeners after the final data event", async () => {
    const observed: string[] = [];
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('first');setTimeout(()=>process.stdout.write('second'),10)",
      ],
      onLog: async (_stream, chunk) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        observed.push(chunk);
      },
    });

    expect(result.stdout).toBe("firstsecond");
    expect(observed.join("")).toBe(result.stdout);
  });

  it("terminates an aborted local process", async () => {
    const controller = new AbortController();
    const promise = runProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30).unref();

    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeDefined();
  });

  it.runIf(process.platform === "win32")(
    "terminates an aborted process tree that inherits stdout",
    async () => {
      const controller = new AbortController();
      const promise = runProcess({
        command: process.execPath,
        args: [
          "-e",
          "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},30000)'],{stdio:'inherit'});setInterval(()=>{},30000)",
        ],
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 30).unref();

      await expect(promise).resolves.toMatchObject({ timedOut: false });
    },
  );

  it.runIf(process.platform === "win32")("runs an npm cmd shim without a shell", async () => {
    const directory = join(tmpdir(), `aaspai-shim-${process.pid}`);
    await mkdir(join(directory, "package"), { recursive: true });
    await writeFile(
      join(directory, "package", "cli.js"),
      "process.stdout.write(`shim ${process.argv[2]}`)",
    );
    await writeFile(
      join(directory, "qa-npm-cli.cmd"),
      '@ECHO off\r\n"%dp0%\\node_modules\\missing.exe" %*\r\n"%_prog%" "%dp0%\\package\\cli.js" %*\r\n',
    );

    const result = await runProcess({
      command: "qa-npm-cli",
      args: ["works"],
      env: { Path: `${directory}${delimiter}${process.env.Path ?? ""}` },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("shim works");
  });

  it("can run with an explicit environment without inheriting worker secrets", async () => {
    process.env.AASPAI_TEST_WORKER_SECRET = "worker-only";
    try {
      const result = await runProcess({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({secret:process.env.AASPAI_TEST_WORKER_SECRET,token:process.env.AASPAI_ATTEMPT_TOKEN,path:Boolean(process.env.PATH ?? process.env.Path)}))",
        ],
        env: {
          AASPAI_ATTEMPT_TOKEN: "ephemeral",
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.Path ? { Path: process.env.Path } : {}),
        },
        inheritEnv: false,
      });

      expect(JSON.parse(result.stdout)).toEqual({
        token: "ephemeral",
        path: true,
      });
    } finally {
      delete process.env.AASPAI_TEST_WORKER_SECRET;
    }
  });

  it("keeps environment inheritance as the direct-process default", async () => {
    process.env.AASPAI_TEST_DIRECT_ENV = "inherited";
    try {
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.AASPAI_TEST_DIRECT_ENV ?? '')"],
      });
      expect(result.stdout).toBe("inherited");
    } finally {
      delete process.env.AASPAI_TEST_DIRECT_ENV;
    }
  });

  it("covers spawn errors, timeout, stdin, and listener failures", async () => {
    const missing = await runProcess({
      command: "missing-aaspai-process",
      args: [],
      onLog: async () => {
        throw new Error("listener");
      },
    });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("spawn error");

    const spawned = vi.fn(() => {
      throw new Error("ignored spawn listener");
    });
    const timed = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.resume();setTimeout(()=>{},1000)"],
      stdin: "input",
      timeoutMs: 20,
      graceMs: 10,
      onSpawn: spawned,
      onLog: async () => {
        throw new Error("ignored log listener");
      },
    });
    expect(spawned).toHaveBeenCalled();
    expect(timed).toMatchObject({ timedOut: true, exitCode: null });
  });

  it("handles an already-aborted signal and truncates each stream", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await runProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},1000)"],
      signal: controller.signal,
      graceMs: 10,
    });
    expect(aborted.exitCode).toBeNull();

    const previous = process.env.AASPAI_RUN_MAX_BUFFER_BYTES;
    process.env.AASPAI_RUN_MAX_BUFFER_BYTES = "8";
    try {
      vi.resetModules();
      const isolated = await import("../src/shared/run-process");
      const result = await isolated.runProcess({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('abcdefghijk');process.stderr.write('123456789');setTimeout(()=>{process.stdout.write('z');process.stderr.write('z')},0)",
        ],
      });
      expect(result.stdout).toContain("truncated");
      expect(result.stderr).toContain("truncated");
    } finally {
      if (previous === undefined) delete process.env.AASPAI_RUN_MAX_BUFFER_BYTES;
      else process.env.AASPAI_RUN_MAX_BUFFER_BYTES = previous;
    }
  });

  it("falls back to the default buffer for invalid buffer configuration", async () => {
    const previous = process.env.AASPAI_RUN_MAX_BUFFER_BYTES;
    process.env.AASPAI_RUN_MAX_BUFFER_BYTES = "not-a-number";
    try {
      vi.resetModules();
      const isolated = await import("../src/shared/run-process");
      await expect(
        isolated.runProcess({
          command: process.execPath,
          args: ["-e", "process.stdout.write('ok')"],
        }),
      ).resolves.toMatchObject({ stdout: "ok" });
    } finally {
      if (previous === undefined) delete process.env.AASPAI_RUN_MAX_BUFFER_BYTES;
      else process.env.AASPAI_RUN_MAX_BUFFER_BYTES = previous;
    }
  });
});
