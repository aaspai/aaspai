import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => false };
});

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(() => ({ doctor: async () => ({ ok: true }) })),
  createAgentRegistry: (value: unknown) => value,
  createRuntimeStore: (value: unknown) => value,
}));

describe("ACP resolver unavailable-package edges", () => {
  it("fails closed when the local ACP package is absent and accepts a configured package", async () => {
    const acpx = await import("acpx/runtime");
    vi.mocked(acpx.createAcpRuntime).mockImplementationOnce(() => {
      throw new Error("acpx unavailable");
    });
    const { resolveAcpEngine } = await import("../src/shared/acp.js");
    const unavailable = await resolveAcpEngine(
      "claude",
      { config: { engine: "auto" }, cwd: process.cwd() },
      { nodeVersion: "v22.13.0" },
    );
    expect(unavailable).toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("unavailable"),
    });

    const ready = await resolveAcpEngine(
      "claude",
      { config: { engine: "auto", agentCommand: "configured" }, cwd: process.cwd() },
      {
        nodeVersion: "v22.13.0",
        createRuntime: (() => ({ doctor: async () => ({ ok: true }) })) as never,
      },
    );
    expect(ready).toEqual({ engine: "acp", explicit: false });
  });
});
