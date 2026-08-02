import { describe, expect, it } from "vitest";
import { BROWSER_SNAPSHOT_TOOL_SOURCE } from "../src/browser-tool.js";

describe("browser_snapshot tool", () => {
  it("pins public HTTPS DNS and bounds browser output", () => {
    expect(BROWSER_SNAPSHOT_TOOL_SOURCE).toContain('target.protocol !== "https:"');
    expect(BROWSER_SNAPSHOT_TOOL_SOURCE).toContain("addresses.some");
    expect(BROWSER_SNAPSHOT_TOOL_SOURCE).toContain('value.startsWith("::ffff:")');
    expect(BROWSER_SNAPSHOT_TOOL_SOURCE).toContain("a === 100 && b >= 64");
    expect(BROWSER_SNAPSHOT_TOOL_SOURCE).toContain("--host-resolver-rules=");
    expect(BROWSER_SNAPSHOT_TOOL_SOURCE).toContain("stdout.slice(0, 100_000)");
  });
});
