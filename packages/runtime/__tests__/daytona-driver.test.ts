import type { Sandbox } from "@daytonaio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@daytonaio/sdk", () => {
  class DaytonaNotFoundError extends Error {}
  class Daytona {
    create = sdk.create;
    get = sdk.get;
    list = sdk.list;
  }
  return { Daytona, DaytonaNotFoundError };
});

import { DaytonaNotFoundError } from "@daytonaio/sdk";
import { DaytonaSandboxDriver } from "../src/shared/providers/daytona-driver.js";

const previousSnapshot = process.env.DAYTONA_SNAPSHOT;
const previousHostAuthPath = process.env.AASPAI_HOST_AUTH_PATH;

beforeEach(() => {
  sdk.create.mockReset();
  sdk.get.mockReset();
  sdk.list.mockReset();
  delete process.env.DAYTONA_SNAPSHOT;
  delete process.env.AASPAI_HOST_AUTH_PATH;
});

afterEach(() => {
  if (previousSnapshot === undefined) delete process.env.DAYTONA_SNAPSHOT;
  else process.env.DAYTONA_SNAPSHOT = previousSnapshot;
  if (previousHostAuthPath === undefined) delete process.env.AASPAI_HOST_AUTH_PATH;
  else process.env.AASPAI_HOST_AUTH_PATH = previousHostAuthPath;
});

describe("DaytonaSandboxDriver", () => {
  it("falls back to the base image when the configured snapshot is missing", async () => {
    const sandbox = fakeSandbox();
    sdk.create
      .mockRejectedValueOnce(new DaytonaNotFoundError("missing"))
      .mockResolvedValue(sandbox);
    const driver = new DaytonaSandboxDriver({
      apiKey: "test",
      snapshot: "missing-snapshot",
      image: "node:22-bookworm-slim",
    });

    const lease = await driver.acquire("/workspace");

    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({ snapshot: "missing-snapshot" });
    expect(sdk.create.mock.calls[1]?.[0]).toMatchObject({ image: "node:22-bookworm-slim" });
    expect(lease.metadata).toMatchObject({ image: "node:22-bookworm-slim", provider: "daytona" });
    expect(lease.metadata).not.toHaveProperty("snapshot");
    await driver.release(lease);
  });

  it("rejects host auth credentials and deletes the new sandbox", async () => {
    process.env.AASPAI_HOST_AUTH_PATH = "host-auth.json";
    const sandbox = fakeSandbox();
    sdk.create.mockResolvedValue(sandbox);
    const driver = new DaytonaSandboxDriver({ apiKey: "test", snapshot: "snapshot-v2" });

    await expect(driver.acquire("/workspace")).rejects.toThrow(
      "AASPAI_HOST_AUTH_PATH is not supported for Daytona",
    );
    expect(sandbox.delete).toHaveBeenCalledOnce();
    expect(driver.activeCount()).toBe(0);
  });
});

function fakeSandbox(): Sandbox {
  const executeCommand = vi.fn(async (command: string) => {
    if (command.startsWith("command -v git")) return { exitCode: 0, result: "0" };
    if (command === "which opencode || true")
      return { exitCode: 0, result: "/usr/local/bin/opencode" };
    if (command === "pwd") return { exitCode: 0, result: "/" };
    return { exitCode: 0, result: "" };
  });
  return {
    id: "sandbox_test",
    state: "started",
    process: { executeCommand },
    fs: {},
    delete: vi.fn(async () => undefined),
  } as unknown as Sandbox;
}
