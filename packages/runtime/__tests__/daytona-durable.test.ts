import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDaytonaProvider } from "../src/index.js";
import type { DaytonaClientSurface } from "../src/providers/daytona/client-surface.js";

interface FakeLease {
  id: string;
  state: string;
  marker: string;
}

function createFakeClient(
  leases: Map<string, FakeLease>,
  seq: { n: number },
  files: Map<string, Uint8Array>,
): DaytonaClientSurface {
  return {
    async create(input) {
      seq.n += 1;
      const id = `fake-sandbox-${seq.n}`;
      leases.set(id, { id, state: "started", marker: "" });
      void input;
      return { id, state: "started" };
    },
    async get(id) {
      return leases.get(id) ?? null;
    },
    async start(id) {
      const lease = leases.get(id);
      if (lease) lease.state = "started";
    },
    async stop(id) {
      const lease = leases.get(id);
      if (lease) lease.state = "stopped";
    },
    async delete(id) {
      leases.delete(id);
    },
    async execute(id: string, input: Parameters<DaytonaClientSurface["execute"]>[1]) {
      const lease = leases.get(id);
      if (!lease) return { exitCode: 1, stdout: "", stderr: "sandbox gone" };
      if (input.command === "pwd") return { exitCode: 0, stdout: "/root\n", stderr: "" };
      if (input.command === "echo")
        return { exitCode: 0, stdout: input.args.join(" "), stderr: "" };
      if (input.command === "cat") return { exitCode: 0, stdout: lease.marker, stderr: "" };
      // The daytona process handle launches via `setsid sh -lc ...` then polls
      // an exit file with `test -f .../exit && cat .../exit`. Simulate the
      // command finishing immediately by answering the exit-file poll with 0.
      if (input.command.includes("/exit") && input.command.includes("test -f")) {
        return { exitCode: 0, stdout: "0", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async fsWrite(id, p, content) {
      void id;
      files.set(p, content);
    },
    async fsRead(id, p) {
      void id;
      if (p.endsWith("/stdout")) return new TextEncoder().encode("ok\n");
      if (p.endsWith("/stderr")) return new Uint8Array();
      return files.get(p) ?? new Uint8Array();
    },
  };
}

const CONFIG = { image: "node:22-bookworm-slim", timeoutMs: 10_000 };

/**
 * Durable lease lifecycle test: simulates worker restart by discarding
 * the entire provider instance between operations. Correctness must come
 * from the persisted `providerLeaseId` + metadata alone — never from
 * in-memory SDK objects.
 */
describe("Daytona: worker-restart durability", () => {
  it("acquire -> discard provider -> resume by id -> execute -> discard -> destroy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aaspai-durable-"));
    try {
      const leases = new Map<string, FakeLease>();
      const seq = { n: 0 };
      const files = new Map<string, Uint8Array>();

      // Provider instance A: acquire a lease, write state.
      const providerA = createDaytonaProvider(CONFIG, {
        clientFactory: async () => createFakeClient(leases, seq, files),
      });
      const lease = await providerA.acquireLease({
        config: CONFIG,
        credentials: { apiKey: "k" },
        logger: nullLogger,
      });
      expect(lease.providerLeaseId).toBe("fake-sandbox-1");

      // Write state into the "sandbox" so a later resume can verify it.
      const fsA = providerA.filesystem?.(lease, {
        credentials: { apiKey: "k" },
        logger: nullLogger,
      });
      const marker = new TextEncoder().encode("durable-marker");
      await fsA?.write("/marker.txt", marker);

      // Discard provider A entirely (worker restart).
      // Provider B: resume the persisted lease by id and execute.
      const providerB = createDaytonaProvider(CONFIG, {
        clientFactory: async () => createFakeClient(leases, seq, files),
      });
      const resumed = await providerB.resumeLease({
        config: CONFIG,
        credentials: { apiKey: "k" },
        logger: nullLogger,
        providerLeaseId: lease.providerLeaseId as string,
        leaseMetadata: { remoteCwd: "/workspace", provider: "daytona" },
      });
      expect(resumed.status).toBe("resumed");
      if (resumed.status !== "resumed") return;
      const result = await providerB.execute?.({
        config: CONFIG,
        credentials: { apiKey: "k" },
        logger: nullLogger,
        lease: resumed.lease,
        request: { command: "echo", args: ["ok"], cwd: "/workspace" },
      });
      expect(result?.exitCode).toBe(0);
      expect(new TextDecoder().decode(result?.stdoutTail).trim()).toBe("ok");

      // The marker survived the restart (workspace sentinel check).
      const fsB = providerB.filesystem?.(resumed.lease, {
        credentials: { apiKey: "k" },
        logger: nullLogger,
      });
      const readBack = await fsB?.read("/marker.txt");
      expect(new TextDecoder().decode(readBack)).toBe("durable-marker");

      // Hibernate (stop), then discard and resume again.
      const released = await providerB.releaseLease({
        config: CONFIG,
        credentials: { apiKey: "k" },
        logger: nullLogger,
        lease: resumed.lease,
        disposition: "hibernate",
      });
      expect(released.disposition).toBe("hibernated");
      expect(leases.get("fake-sandbox-1")?.state).toBe("stopped");

      // Provider C: resume the hibernated lease (start) then destroy.
      const providerC = createDaytonaProvider(CONFIG, {
        clientFactory: async () => createFakeClient(leases, seq, files),
      });
      const resumedAgain = await providerC.resumeLease({
        config: CONFIG,
        credentials: { apiKey: "k" },
        logger: nullLogger,
        providerLeaseId: lease.providerLeaseId as string,
        leaseMetadata: { remoteCwd: "/workspace", provider: "daytona" },
      });
      expect(resumedAgain.status).toBe("resumed");
      const destroyed = await providerC.destroyLease({
        config: CONFIG,
        credentials: { apiKey: "k" },
        logger: nullLogger,
        providerLeaseId: lease.providerLeaseId as string,
        leaseMetadata: { provider: "daytona" },
      });
      expect(destroyed.destroyed).toBe(true);
      expect(leases.has("fake-sandbox-1")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resume returns expired for a missing lease", async () => {
    const leases = new Map<string, FakeLease>();
    const seq = { n: 0 };
    const files = new Map<string, Uint8Array>();
    const provider = createDaytonaProvider(CONFIG, {
      clientFactory: async () => createFakeClient(leases, seq, files),
    });
    const resumed = await provider.resumeLease({
      config: CONFIG,
      credentials: { apiKey: "k" },
      logger: nullLogger,
      providerLeaseId: "no-such-sandbox",
      leaseMetadata: {},
    });
    expect(resumed.status).toBe("expired");
  });

  it("requires credentials", async () => {
    const provider = createDaytonaProvider(CONFIG);
    await expect(
      provider.acquireLease({ config: CONFIG, credentials: {}, logger: nullLogger }),
    ).rejects.toThrow(/API key/);
  });
});

const nullLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
