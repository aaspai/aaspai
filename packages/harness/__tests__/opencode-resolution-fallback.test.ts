import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => false };
});

vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    _args: string[],
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => callback(null, { stdout: "", stderr: "" }),
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("not found")));
    return child;
  },
}));

describe("OpenCode binary resolver fallback", () => {
  it("returns the literal command after PATH lookup fails", async () => {
    process.env.OPENCODE_CLI = "missing-opencode-env";
    delete process.env.APPDATA;
    const { opencodeProviders } = await import("../src/drivers/opencode-cli/implementation.js");
    await expect(opencodeProviders({})).resolves.toEqual([]);
  });
});
