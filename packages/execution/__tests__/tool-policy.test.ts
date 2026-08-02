import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import type { ResolvedAgentProfile } from "@aaspai/contracts/profile";
import { describe, expect, it, vi } from "vitest";
import { enforceRuntimeToolPolicy } from "../src/harness-runner";

describe("runtime tool policy", () => {
  it("fails closed for approvals and incomplete Codex native bundles", () => {
    expect(() =>
      enforceRuntimeToolPolicy("claude_local", {}, profile([native("Bash", true)])),
    ).toThrow(/no runtime approval broker/);
    expect(() => enforceRuntimeToolPolicy("codex_local", {}, profile([native("shell")]))).toThrow(
      /complete sandboxed native tool bundle/,
    );
    expect(() =>
      enforceRuntimeToolPolicy(
        "claude_local",
        { extraArgs: ["--tools=Bash"] },
        profile([native("Read")]),
      ),
    ).toThrow(/cannot override/);
  });

  it("restricts Claude, OpenCode, and adapter-dispatched tools", async () => {
    const invoke = vi.fn(async (name: string) => name);
    const dispatcher = {
      invoke,
    } as AdapterExecutionContext["tools"];
    const resolved = profile([native("Read"), native("Bash"), custom("echo")]);

    const claude = enforceRuntimeToolPolicy("claude_local", {}, resolved, dispatcher);
    expect(claude.adapterConfig).toMatchObject({
      tools: ["Read", "Bash"],
      permissionMode: "default",
      dangerouslySkipPermissions: false,
    });
    await expect(claude.tools?.invoke("echo", {}, {})).resolves.toBe("echo");
    await expect(claude.tools?.invoke("write", {}, {})).rejects.toThrow(/denied/);
    expect(invoke).toHaveBeenCalledTimes(1);

    const codex = enforceRuntimeToolPolicy(
      "codex_local",
      {},
      profile(["apply_patch", "shell", "web_search", "view_image"].map((name) => native(name))),
    );
    expect(codex.adapterConfig).toMatchObject({
      sandbox: "workspace-write",
      approvalMode: "never",
    });

    const opencode = enforceRuntimeToolPolicy("opencode_cli", {}, resolved);
    expect(opencode.adapterConfig).toMatchObject({
      autoApprove: false,
      dangerouslySkipPermissions: false,
      disableProjectConfig: true,
      permissions: { "*": "deny", read: "allow", bash: "allow" },
    });
  });
});

function native(name: string, requiresApproval = false) {
  return {
    name,
    allowed: true,
    ready: true,
    requiresApproval,
    tool: { name, description: "Harness-native tool", risk: "safe" },
  };
}

function custom(name: string) {
  return {
    name,
    allowed: true,
    ready: true,
    requiresApproval: false,
    tool: { name, description: "Custom tool", risk: "safe" },
  };
}

function profile(tools: unknown[]): ResolvedAgentProfile {
  return { tools } as unknown as ResolvedAgentProfile;
}
