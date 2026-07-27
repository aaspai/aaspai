import { describe, expect, it } from "vitest";
import { createBuiltInRegistry } from "../src";

describe("tool readiness boundary", () => {
  it("marks built-in stubs unavailable and rejects invocation", async () => {
    const registry = createBuiltInRegistry();
    expect(registry.readiness("Bash").ready).toBe(false);
    await expect(registry.call("Bash", {}, {})).rejects.toThrow(/unavailable/);
  });
});
