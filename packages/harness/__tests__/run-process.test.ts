import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/shared/run-process";

describe("runProcess cancellation", () => {
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
});
