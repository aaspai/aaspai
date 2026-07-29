import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { SandboxClient, SandboxLease } from "@aaspai/runtime";
import {
  buildSandboxNpmInstallCommand,
  createDockerTarget,
  createSdkSandboxTarget,
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
  SdkSandboxDriver,
  sandboxExecutionTargetSchema,
  sandboxSpecSchema,
  shellCommandArgs,
  shellQuote,
  sshExecutionTargetSchema,
} from "@aaspai/runtime";
import { describe, expect, it } from "vitest";
import { buildRemoteExecutionCommand } from "../src/drivers/ssh/index";

describe("runtime contract", () => {
  it("quotes SSH commands and forwards only explicit remote environment values", () => {
    const command = buildRemoteExecutionCommand("/tmp/work", "/tmp/work/pid", {
      command: "agent cli",
      args: ["say 'hello'"],
      env: { TOKEN: "secret value" },
    });
    expect(command).toContain("'TOKEN=secret value'");
    expect(command).toContain(`${shellQuote("agent cli")} ${shellQuote("say 'hello'")}`);
    expect(command).not.toContain("process.env");
  });

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
    const daytona = all.find((target) => target.provider === "daytona");
    expect(daytona?.capabilities).toMatchObject({
      restore: true,
      resume: true,
      artifacts: false,
    });
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
    const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const workspaceRoot = resolve("..", "..", "workspace", "m1");
    await mkdir(workspaceRoot, { recursive: true });
    const testDirectory = await mkdtemp(`${workspaceRoot}/runtime-cancel-`);
    const controller = new AbortController();
    try {
      const client = new LocalSandboxClient(testDirectory);
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
    } finally {
      await rm(testDirectory, { recursive: true, force: true });
    }
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

describe("e2b local backend", () => {
  it("runs a command through the local backend and returns exit code 0", async () => {
    const { createLocalSandboxTarget } = await import("../src/shared/local-sandbox-target.js");
    const local = createLocalSandboxTarget({
      providerKey: "e2b",
      label: "e2b (local backend)",
    });
    const result = await local.run(
      { kind: "sandbox", provider: "e2b", remoteCwd: "/tmp" },
      { command: "node", args: ["-e", "process.stdout.write('e2b-ok')"] },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("e2b-ok");
  });
  it("has provider= e2b and status= ready", () => {
    expect(e2bTarget.info.kind).toBe("sandbox");
    expect(e2bTarget.info.provider).toBe("e2b");
    expect(e2bTarget.info.status).toBe("ready");
  });
  it("real e2b provider throws clear 'API key required' on run without env", async () => {
    // Real E2B SDK is wired up; without E2B_API_KEY it must fail at
    // the SDK call, not at module load. This proves the provider
    // is real code, not a stub.
    const prev = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      await expect(
        e2bTarget.run(
          { kind: "sandbox", provider: "e2b", remoteCwd: "/tmp" },
          { command: "echo", args: ["hi"] },
        ),
      ).rejects.toThrow(/E2B_API_KEY|E2B sandbox requires an API key/);
    } finally {
      if (prev !== undefined) process.env.E2B_API_KEY = prev;
    }
  });
});

describe("SDK sandbox workspace lifecycle", () => {
  it("uploads the assigned workspace, runs remotely, restores, and releases", async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "aaspai-sdk-target-"));
    const driver = new RecordingSandboxDriver();
    try {
      await writeFile(join(workspace, "input.txt"), "workspace-marker\n");
      const target = createSdkSandboxTarget({
        driver,
        providerKey: "daytona",
        label: "test",
        capabilities: {
          execute: true,
          streaming: true,
          cancellation: true,
          timeout: true,
          workspaceIsolation: true,
          restore: true,
          resume: false,
          artifacts: false,
        },
      });

      const output: string[] = [];
      const runResult = await target.run(
        { kind: "sandbox", provider: "daytona", remoteCwd: "/workspace" },
        {
          command: "node",
          args: ["-e", "console.log('remote')"],
          cwd: workspace,
          onLog: (_stream, chunk) => {
            output.push(chunk);
          },
        },
      );

      expect(runResult.exitCode).toBe(0);
      expect(runResult.runtimeIdentity?.connectionIdentity).toBe("daytona:lease_test");
      expect(driver.uploadedBytes).toBeGreaterThan(0);
      expect(driver.commands.map((entry) => entry.command)).toEqual(["sh", "node", "sh"]);
      expect(driver.commands[1]?.cwd).toBe("/workspace");
      expect(output).toEqual(["remote\n"]);
      await expect(readFile(join(workspace, "output.txt"), "utf8")).resolves.toBe("restored\n");
      expect(driver.released).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("pauses and resumes the same provider lease", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "aaspai-sdk-resume-"));
    const driver = new RecordingSandboxDriver();
    const target = createSdkSandboxTarget({
      driver,
      providerKey: "daytona",
      label: "test",
      capabilities: {
        execute: true,
        streaming: true,
        cancellation: true,
        timeout: true,
        workspaceIsolation: true,
        restore: true,
        resume: true,
        artifacts: false,
      },
    });
    try {
      await writeFile(join(workspace, "input.txt"), "resume\n");
      await target.run(
        {
          kind: "sandbox",
          provider: "daytona",
          remoteCwd: "/workspace",
          metadata: { reuseLease: true },
        },
        { command: "node", args: [], cwd: workspace },
      );
      expect(driver.paused).toBe(true);

      await target.run(
        {
          kind: "sandbox",
          provider: "daytona",
          remoteCwd: "/workspace",
          metadata: { providerLeaseId: "lease_test" },
        },
        { command: "node", args: [] },
      );
      expect(driver.resumed).toBe(true);
      expect(driver.released).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("Docker environment provider", () => {
  it("runs a plan in a disposable container and streams output", async () => {
    const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const workspaceRoot = join(process.cwd(), "workspace", "m8");
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await mkdtemp(join(workspaceRoot, "docker-provider-"));
    const calls: string[][] = [];
    const output: string[] = [];
    const commandRunner = {
      async run(options: {
        args: string[];
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
      }) {
        calls.push(options.args);
        switch (options.args[0]) {
          case "create":
            return result({ stdout: "container_123\n" });
          case "inspect":
            return result({ stdout: "running\n" });
          case "exec":
            await options.onLog?.("stdout", "inside\n");
            return result({ stdout: "inside\n" });
          case "start":
          case "rm":
            return result({});
          default:
            throw new Error(`unexpected docker operation: ${options.args[0]}`);
        }
      },
    };
    try {
      const target = createDockerTarget({ commandRunner, cleanupRetries: 1 });
      const runResult = await target.run(
        {
          kind: "docker",
          image: "node:22",
          network: "none",
          cwd: workspace,
        },
        {
          command: "node",
          args: ["-e", "console.log('inside')"],
          onLog: async (_stream, chunk) => {
            output.push(chunk);
          },
        },
      );

      expect(runResult.exitCode).toBe(0);
      expect(output).toEqual(["inside\n"]);
      expect(calls.map((args) => args[0])).toEqual(["create", "start", "inspect", "exec", "rm"]);
      expect(calls[0]).toContain(`type=bind,source=${workspace},target=/workspace`);
      expect(calls[3]).toEqual([
        "exec",
        "--workdir",
        "/workspace",
        "container_123",
        "node",
        "-e",
        "console.log('inside')",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports a missing container during recovery", async () => {
    const provider = (
      await import("../src/drivers/docker/index.js")
    ).createDockerEnvironmentProvider({
      cleanupRetries: 1,
      commandRunner: {
        async run() {
          return result({ exitCode: 1, stderr: "No such container" });
        },
      },
    });
    await expect(provider.recover("missing_container")).resolves.toBe("missing");
  });
});

function result(
  overrides: Partial<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }> = {},
) {
  const now = new Date().toISOString();
  return {
    exitCode: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    ...overrides,
  };
}

class RecordingSandboxDriver extends SdkSandboxDriver<Record<string, never>> {
  commands: RunProcessOptions[] = [];
  uploadedBytes = 0;
  released = false;
  paused = false;
  resumed = false;

  constructor() {
    super("daytona");
  }

  protected async createSandbox() {
    return { raw: {}, remoteCwd: "/workspace", metadata: {} };
  }

  protected async reconnect(providerLeaseId: string) {
    this.resumed = providerLeaseId === "lease_test";
    return this.resumed ? {} : null;
  }

  protected async destroySandbox() {
    this.released = true;
  }

  protected override async pauseSandbox() {
    this.paused = true;
  }

  protected leaseId() {
    return "lease_test";
  }

  protected buildClient(_raw: Record<string, never>, _lease: SandboxLease): SandboxClient {
    return {
      makeDir: async () => undefined,
      writeFile: async (_path, content) => {
        this.uploadedBytes +=
          typeof content === "string" ? Buffer.byteLength(content) : content.length;
      },
      readFile: async () =>
        Buffer.from(
          "diff --git a/output.txt b/output.txt\nnew file mode 100644\n--- /dev/null\n+++ b/output.txt\n@@ -0,0 +1 @@\n+restored\n",
        ),
      listFiles: async () => [],
      remove: async () => undefined,
      run: async (options): Promise<RunProcessResult> => {
        this.commands.push(options);
        if (options.command === "node") await options.onLog?.("stdout", "remote\n");
        return result({ stdout: options.command === "node" ? "remote\n" : "" });
      },
    };
  }
}
