import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import {
  LocalSandboxClient,
  type SandboxClient,
  type SandboxDriver,
  type SandboxLease,
} from "./sandbox-client.js";

/**
 * In-process `SandboxDriver` implementation. Used as the test/local
 * backend for every sandbox provider when no cloud API key is
 * configured. Each "lease" is a fresh temp directory on the host
 * (created by `acquire` and removed by `release`).
 *
 * Provider SDKs swap in by replacing the body of `client()` and the
 * lease-id scheme; everything else (acquire/resume/release/destroy)
 * follows the same shape.
 */
export class LocalSandboxDriver implements SandboxDriver {
  private readonly activeLeases = new Map<string, { baseDir: string; remoteCwd: string }>();

  constructor(private readonly providerKey: string) {}

  /**
   * Create a fresh "lease" by allocating a temp directory. Returns the
   * lease descriptor; the caller can then ask for a `SandboxClient` via
   * `client(lease)`.
   */
  async acquire(remoteCwd: string, _options?: { timeoutMs?: number }): Promise<SandboxLease> {
    const baseDir = join(
      tmpdir(),
      `aaspai-${this.providerKey}-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    );
    await mkdir(baseDir, { recursive: true });
    const providerLeaseId = `local-${this.providerKey}-${randomUUID().slice(0, 8)}`;
    this.activeLeases.set(providerLeaseId, { baseDir, remoteCwd });
    return {
      providerLeaseId,
      remoteCwd,
      metadata: { baseDir, backend: "local" },
    };
  }

  /**
   * Reconnect to an existing lease. With a local backend, the lease
   * must still exist on disk; otherwise return null.
   */
  async resume(providerLeaseId: string): Promise<SandboxLease | null> {
    const rec = this.activeLeases.get(providerLeaseId);
    if (!rec) return null;
    if (!existsSync(rec.baseDir)) {
      this.activeLeases.delete(providerLeaseId);
      return null;
    }
    return {
      providerLeaseId,
      remoteCwd: rec.remoteCwd,
      metadata: { baseDir: rec.baseDir, backend: "local" },
    };
  }

  /**
   * Pause the lease (if reuseLease) or destroy it. Local backends
   * always destroy (the temp dir is short-lived).
   */
  async release(lease: SandboxLease, _options?: { reuseLease?: boolean }): Promise<void> {
    const rec = this.activeLeases.get(lease.providerLeaseId);
    if (!rec) return;
    this.activeLeases.delete(lease.providerLeaseId);
    await rm(rec.baseDir, { recursive: true, force: true });
  }

  /**
   * Force-destroy a lease, ignoring reuseLease.
   */
  async destroy(providerLeaseId: string): Promise<void> {
    const rec = this.activeLeases.get(providerLeaseId);
    if (!rec) return;
    this.activeLeases.delete(providerLeaseId);
    await rm(rec.baseDir, { recursive: true, force: true });
  }

  /**
   * Return a 6-method client bound to the lease's local temp dir.
   * The `run` method delegates to `LocalSandboxClient.run` and the
   * cwd is forced to the lease's remote cwd.
   */
  client(lease: SandboxLease): SandboxClient {
    const rec = this.activeLeases.get(lease.providerLeaseId);
    if (!rec) throw new Error(`LocalSandboxDriver: unknown lease ${lease.providerLeaseId}`);
    const baseDir = rec.baseDir;
    const fsClient = new LocalSandboxClient(baseDir);
    return {
      makeDir: fsClient.makeDir.bind(fsClient),
      writeFile: fsClient.writeFile.bind(fsClient),
      readFile: fsClient.readFile.bind(fsClient),
      listFiles: fsClient.listFiles.bind(fsClient),
      remove: fsClient.remove.bind(fsClient),
      async run(options: RunProcessOptions): Promise<RunProcessResult> {
        return await fsClient.run({
          ...options,
          cwd: options.cwd ?? rec.remoteCwd ?? baseDir,
        });
      },
    };
  }

  /**
   * For tests: list currently active leases.
   */
  listActiveLeases(): string[] {
    return [...this.activeLeases.keys()];
  }
}
