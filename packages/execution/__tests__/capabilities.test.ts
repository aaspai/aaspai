import { describe, expect, it } from "vitest";
import {
  assertExecutionPlanCapabilities,
  assertHarnessExecutable,
  ProviderCapabilityError,
} from "../src/capabilities.js";

describe("provider capability guards", () => {
  it("accepts an executable harness and rejects a stub before dispatch", () => {
    expect(() => assertHarnessExecutable("dry_run_local")).not.toThrow();
    expect(() => assertHarnessExecutable("cursor_local")).toThrowError(ProviderCapabilityError);
  });

  it("rejects a stub runtime with a stable error code", () => {
    expect(() =>
      assertExecutionPlanCapabilities({
        harness: "dry_run_local",
        target: {
          kind: "ssh",
          host: "example.com",
          port: 22,
          username: "root",
          remoteCwd: "/work",
          strictHostKeyChecking: true,
          shellCommand: "bash",
        },
      }),
    ).toThrowError(ProviderCapabilityError);
    let captured: unknown;
    try {
      assertExecutionPlanCapabilities({
        harness: "dry_run_local",
        target: { kind: "sandbox", provider: "e2b", remoteCwd: "/work" },
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "provider_capability_unsupported" });
  });
});
