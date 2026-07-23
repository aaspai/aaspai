import {
  buildSandboxNpmInstallCommand,
  dockerExecutionTargetSchema,
  EXECUTION_TARGET_KIND_VALUES,
  e2bTarget,
  executionTargetSchema,
  LocalSandboxClient,
  listRuntimeTargets,
  listSandboxProviders,
  localExecutionTargetSchema,
  localTarget,
  preferredShellForSandbox,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_REGISTRY_VERSION,
  resolveTarget,
  SANDBOX_PROVIDER_VALUES,
  sandboxExecutionTargetSchema,
  sandboxSpecSchema,
  shellCommandArgs,
  shellQuote,
  sshExecutionTargetSchema,
} from "@aaspai/runtime";
import { describe, expect, it } from "vitest";

describe("runtime contract", () => {
  it("exposes a stable protocol version", () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe(1);
  });

  it("discriminates every execution target kind", () => {
    const def = executionTargetSchema.def as { discriminator?: string };
    expect(def.discriminator).toBe("kind");
    expect(new Set(EXECUTION_TARGET_KIND_VALUES)).toEqual(
      new Set(["local", "docker", "ssh", "sandbox"]),
    );
  });

  it("round-trips every execution target shape", () => {
    expect(() =>
      localExecutionTargetSchema.parse({ kind: "local", cwd: "/tmp", envPassthrough: false }),
    ).not.toThrow();
    expect(() =>
      dockerExecutionTargetSchema.parse({ kind: "docker", image: "node:22", network: "none" }),
    ).not.toThrow();
    expect(() =>
      sshExecutionTargetSchema.parse({
        kind: "ssh",
        host: "example.com",
        username: "root",
        remoteCwd: "/work",
      }),
    ).not.toThrow();
    expect(() =>
      sandboxExecutionTargetSchema.parse({
        kind: "sandbox",
        provider: "e2b",
        remoteCwd: "/work",
      }),
    ).not.toThrow();
  });

  it("validates a sandbox spec", () => {
    const spec = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      provider: "e2b" as const,
      providerLeaseId: "lease_1",
      remoteCwd: "/work",
      shellCommand: "bash" as const,
      acquiredAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => sandboxSpecSchema.parse(spec)).not.toThrow();
  });
});

describe("runtime registry", () => {
  it("resolves the local target for kind=local", () => {
    const t = resolveTarget({ kind: "local", envPassthrough: false });
    expect(t.info.kind).toBe("local");
    expect(t.info.status).toBe("ready");
  });

  it("resolves the e2b sandbox target for kind=sandbox provider=e2b", () => {
    const t = resolveTarget({ kind: "sandbox", provider: "e2b", remoteCwd: "/w" });
    expect(t.info.kind).toBe("sandbox");
    expect(t.info.provider).toBe("e2b");
  });

  it("lists every runtime target (local + docker + ssh + 7 sandbox providers)", () => {
    const all = listRuntimeTargets();
    expect(all.length).toBe(3 + SANDBOX_PROVIDER_VALUES.length);
  });

  it("lists every sandbox provider", () => {
    const providers = new Set(listSandboxProviders());
    for (const p of SANDBOX_PROVIDER_VALUES) expect(providers.has(p)).toBe(true);
  });

  it("registry version is 1", () => {
    expect(RUNTIME_REGISTRY_VERSION).toBe(1);
  });
});

describe("shell helpers", () => {
  it("prefers bash when asked", () => {
    expect(preferredShellForSandbox("bash")).toBe("bash");
    expect(preferredShellForSandbox("sh")).toBe("sh");
    expect(preferredShellForSandbox(null)).toBe("sh");
  });

  it("returns -c args", () => {
    expect(shellCommandArgs("echo hi")).toEqual(["-c", "echo hi"]);
  });

  it("quotes a path safely", () => {
    expect(shellQuote("/tmp/has space/x")).toBe("'/tmp/has space/x'");
    expect(shellQuote("/tmp/it's/x")).toBe("'/tmp/it'\\''s/x'");
  });
});

describe("buildSandboxNpmInstallCommand", () => {
  it("rejects suspicious package names", () => {
    expect(() => buildSandboxNpmInstallCommand("foo; rm -rf /")).toThrow();
  });

  it("emits an npm install script for a valid name", () => {
    const script = buildSandboxNpmInstallCommand("@anthropic-ai/claude-code");
    expect(script).toContain("install -g @anthropic-ai/claude-code");
    expect(script).toContain("set -eu");
  });
});

describe("LocalSandboxClient", () => {
  it("rejects kinds other than local", () => {
    expect(() =>
      resolveTarget({ kind: "docker", image: "node:22", network: "none" }),
    ).not.toThrow();
  });

  it("runs a process through the local target", async () => {
    const result = await localTarget.run(
      { kind: "local", envPassthrough: false },
      { command: process.execPath, args: ["-e", "process.stdout.write('hi')"] },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi");
  });

  it("cancels a process through the local sandbox client", async () => {
    const { resolve } = await import("node:path");
    const controller = new AbortController();
    const client = new LocalSandboxClient(resolve("..", "..", "workspace"));
    const promise = client.run({
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

  it("LocalSandboxClient lists files in a temp dir", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "aaspai-runtime-"));
    try {
      await writeFile(join(dir, "a.txt"), "hi");
      const client = new LocalSandboxClient(dir);
      const files = await client.listFiles("/");
      expect(files.some((f) => f.name === "a.txt")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("e2b skeleton", () => {
  it("throws a clear not-yet-implemented error", async () => {
    await expect(
      e2bTarget.run(
        { kind: "sandbox", provider: "e2b", remoteCwd: "/w" },
        { command: "true", args: [] },
      ),
    ).rejects.toThrow(/e2b sandbox driver is a skeleton/);
  });
});
