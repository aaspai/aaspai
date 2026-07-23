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
});
