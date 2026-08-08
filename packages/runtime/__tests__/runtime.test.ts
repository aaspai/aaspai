import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBytesEqual,
  BoundedByteBuffer,
  createLocalProvider,
  createLocalProviderFromConfig,
  createRuntimeRegistry,
  localConfigSchema,
  localManifest,
  OrderedStream,
  startLocalProcess,
} from "../src/index.js";
import { runProviderContract } from "../src/testing/index.js";

describe("Runtime core: bounded buffer", () => {
  it("keeps the last N bytes in tail mode", () => {
    const buf = new BoundedByteBuffer({ maxBytes: 8, mode: "tail" });
    buf.append(new TextEncoder().encode("abcdefghijkl"));
    expect(buf.toString()).toBe("efghijkl");
    expect(buf.size).toBe(8);
  });

  it("tracks real bytes, not string length", () => {
    const buf = new BoundedByteBuffer({ maxBytes: 4, mode: "tail" });
    buf.append(new TextEncoder().encode("🙂🙂")); // 8 bytes, 2 chars
    expect(buf.size).toBe(4);
    expect(buf.toUint8Array().byteLength).toBe(4);
  });

  it("keeps head + tail in head+tail mode", () => {
    const buf = new BoundedByteBuffer({ maxBytes: 12, mode: "head+tail", headBytes: 4 });
    buf.append(new TextEncoder().encode("abcdefghijklmnop"));
    expect(buf.toString()).toBe("abcdijklmnop");
  });
});

describe("Runtime core: ordered stream", () => {
  it("awaits each handler before the next", async () => {
    const order: number[] = [];
    const stream = new OrderedStream<number>(async (n) => {
      order.push(n);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    stream.push(1);
    stream.push(2);
    stream.push(3);
    await stream.close();
    expect(order).toEqual([1, 2, 3]);
  });

  it("close() waits for buffered handlers", async () => {
    let done = 0;
    const stream = new OrderedStream<number>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done += 1;
    });
    stream.push(1);
    stream.push(2);
    await stream.close();
    expect(done).toBe(2);
  });
});

describe("Local provider", () => {
  it("validates config", async () => {
    const provider = createLocalProvider({ root: tmpdir() });
    const outcome = await provider.validateConfig(localConfigSchema.parse({}));
    expect(outcome.ok).toBe(true);
  });

  it("acquires a lease, realizes workspace, executes, and releases", async () => {
    const provider = createLocalProvider({ root: tmpdir() });
    const dir = await mkdtemp(join(tmpdir(), "aaspai-runtime-"));
    try {
      const lease = await provider.acquireLease({
        config: {},
        credentials: {},
        logger: nullLogger,
        localPath: dir,
      });
      expect(lease.providerLeaseId).toBe("local");
      const ws = await provider.realizeWorkspace({
        config: {},
        credentials: {},
        logger: nullLogger,
        lease,
        localPath: dir,
      });
      expect(ws.cwd).toBe(dir);
      const result = await provider.execute?.({
        config: {},
        credentials: {},
        logger: nullLogger,
        lease,
        request: { command: process.execPath, args: ["-e", "process.stdout.write('hi')"] },
      });
      expect(result?.exitCode).toBe(0);
      expect(new TextDecoder().decode(result?.stdoutTail)).toBe("hi");
      const release = await provider.releaseLease({
        config: {},
        credentials: {},
        logger: nullLogger,
        lease,
        disposition: "destroy",
      });
      expect(release.disposition).toBe("destroyed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out a sleep and reports timed_out", async () => {
    const provider = createLocalProvider({});
    const lease = await provider.acquireLease({ config: {}, credentials: {}, logger: nullLogger });
    const result = await provider.execute?.({
      config: {},
      credentials: {},
      logger: nullLogger,
      lease,
      request: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30000)"],
        timeoutMs: 200,
      },
    });
    expect(result?.status).toBe("timed_out");
  });

  it("cancels a running process", async () => {
    const provider = createLocalProvider({});
    const lease = await provider.acquireLease({ config: {}, credentials: {}, logger: nullLogger });
    const handle = await provider.startExecution({
      config: {},
      credentials: {},
      logger: nullLogger,
      lease,
      request: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handle.cancel("test");
    const result = await handle.wait();
    expect(result.status).toBe("cancelled");
  });

  it("binary filesystem round-trip is byte-exact", async () => {
    const provider = createLocalProvider({});
    const dir = await mkdtemp(join(tmpdir(), "aaspai-runtime-bin-"));
    try {
      const lease = await provider.acquireLease({
        config: { root: dir },
        credentials: {},
        logger: nullLogger,
        localPath: dir,
      });
      const fs = provider.filesystem?.(lease, { credentials: {}, logger: nullLogger });
      expect(fs).toBeTruthy();
      const input = new Uint8Array(1024);
      for (let i = 0; i < input.byteLength; i += 1) input[i] = (i * 31) & 0xff;
      await fs!.write("/test.bin", input);
      const output = await fs!.read("/test.bin");
      assertBytesEqual(output, input, "local binary roundtrip");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Runtime registry", () => {
  it("lists lazy descriptors without loading SDKs", async () => {
    const registry = createRuntimeRegistry({
      local: {
        manifest: localManifest,
        load: async () => ({
          createProvider: (input) => createLocalProviderFromConfig(input.config),
        }),
      },
    });
    const list = registry.list();
    expect(list.length).toBe(1);
    expect(list[0]?.manifest.type).toBe("local");
    const provider = await registry.createProvider("local", { config: {} });
    expect(provider.manifest.type).toBe("local");
  });
});

describe("Provider contract", () => {
  it("local provider passes the contract suite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aaspai-contract-"));
    try {
      const result = await runProviderContract({
        manifest: localManifest,
        context: {
          config: { root: dir },
          workspaceDir: dir,
          createProvider: async (input) => createLocalProviderFromConfig(input.config),
        },
      });
      expect(result.failed).toEqual([]);
      expect(result.passed.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Local process handle", () => {
  it("supports start -> stream -> wait", async () => {
    const chunks: string[] = [];
    const handle = await startLocalProcess(
      { command: process.execPath, args: ["-e", "console.log('one'); console.log('two')"] },
      {},
      { onStdout: (c) => void chunks.push(new TextDecoder().decode(c)) },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(chunks.join("").includes("one")).toBe(true);
    expect(chunks.join("").includes("two")).toBe(true);
  });

  it("writes stdin to the child", async () => {
    const handle = await startLocalProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', d => process.stdout.write('got:' + d.toString()))"],
    });
    await handle.writeStdin?.("hello");
    await handle.closeStdin?.();
    const result = await handle.wait();
    expect(new TextDecoder().decode(result.stdoutTail)).toBe("got:hello");
  });
});

const nullLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
