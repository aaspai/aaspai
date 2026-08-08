import type { RuntimeProviderManifest } from "../core/contracts/index.js";
import type { ProviderTestContext } from "./harness.js";
import { assertBytesEqual } from "./harness.js";

export interface DefineProviderContractInput {
  manifest: RuntimeProviderManifest;
  context: ProviderTestContext;
  /** Skip a specific test name (e.g. for providers missing an optional capability). */
  skip?: string[];
}

/**
 * Run every contract test that the manifest's capabilities imply. A
 * capability may be true only if its test passes; tests that are not
 * implied by the manifest are skipped.
 */
export async function runProviderContract(input: DefineProviderContractInput): Promise<{
  passed: string[];
  skipped: string[];
  failed: { name: string; error: Error }[];
}> {
  const { manifest, context, skip } = input;
  const provider = await context.createProvider({
    config: context.config,
    credentials: context.credentials,
  });
  const passed: string[] = [];
  const skipped: string[] = [];
  const failed: { name: string; error: Error }[] = [];

  const run = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    if (skip?.includes(name)) {
      skipped.push(name);
      return;
    }
    try {
      await fn();
      passed.push(name);
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error : new Error(String(error)) });
    }
  };

  // A manifest is a capability claim, not documentation. Fail the contract
  // immediately when the provider surface cannot possibly implement a
  // declared production capability. This keeps a green test suite from
  // silently inheriting false claims as providers are added.
  await run("capabilities.surface", async () => {
    const declared = manifest.capabilities;
    if (provider.manifest.type !== manifest.type) {
      throw new Error(
        `provider manifest mismatch: expected ${manifest.type}, got ${provider.manifest.type}`,
      );
    }
    if (declared.execute && !provider.execute && !provider.startExecution) {
      throw new Error("execute capability requires execute() or startExecution()");
    }
    if (declared.streaming && !provider.startExecution) {
      throw new Error("streaming capability requires startExecution()");
    }
    if (declared.reusableLease && manifest.leaseModel !== "reusable") {
      throw new Error("reusableLease capability requires a reusable lease model");
    }
    if (declared.destroyById && !provider.destroyLease) {
      throw new Error("destroyById capability requires destroyLease()");
    }
    if (declared.binaryFilesystem && !provider.filesystem) {
      throw new Error("binaryFilesystem capability requires filesystem()");
    }
    if ((declared.upload || declared.download) && !provider.filesystem) {
      throw new Error("upload/download capabilities require filesystem()");
    }
    if (declared.privateEndpoints && !provider.exposeEndpoint) {
      throw new Error("privateEndpoints capability requires exposeEndpoint()");
    }
    if (declared.processReattachment && !provider.reattachExecution) {
      throw new Error("processReattachment capability requires reattachExecution()");
    }
  });

  await run("config.validation", async () => {
    const outcome = await provider.validateConfig(context.config);
    if (!outcome.ok) throw new Error(`config rejected: ${outcome.errors.join("; ")}`);
  });

  await run("probe", async () => {
    const probe = await provider.probe({
      config: context.config,
      credentials: context.credentials ?? {},
      logger: nullLogger,
    });
    if (!probe.ok) throw new Error(probe.error ?? "probe failed");
  });

  // Base lifecycle: acquire -> realize -> run -> release.
  await run("lifecycle.basic", async () => {
    const lease = await provider.acquireLease({
      config: context.config,
      credentials: context.credentials ?? {},
      logger: nullLogger,
    });
    if (!lease.providerLeaseId) throw new Error("acquireLease returned no providerLeaseId");
    const workspace = await provider.realizeWorkspace({
      config: context.config,
      credentials: context.credentials ?? {},
      logger: nullLogger,
      lease,
      localPath: context.workspaceDir,
      remotePath: "/workspace",
    });
    if (!workspace.cwd) throw new Error("realizeWorkspace returned no cwd");
    const result = await provider.execute?.({
      config: context.config,
      credentials: context.credentials ?? {},
      logger: nullLogger,
      lease,
      request: { command: "echo", args: ["hello"] },
    });
    if (!result) throw new Error("provider has no execute()");
    if (result.exitCode !== 0) throw new Error(`echo exited ${result.exitCode}`);
    await provider.releaseLease({
      config: context.config,
      credentials: context.credentials ?? {},
      logger: nullLogger,
      lease,
      disposition: "destroy",
    });
  });

  if (manifest.capabilities.streaming) {
    await run("streaming.ordered", async () => {
      const lease = await provider.acquireLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
      });
      const order: string[] = [];
      const result = await provider.execute?.({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        lease,
        request: {
          command: "sh",
          args: ["-c", "printf A; sleep 0.2; printf B; sleep 0.2; printf C"],
        },
        onStdout: async (chunk) => {
          order.push(new TextDecoder().decode(chunk));
        },
      });
      await provider.releaseLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        lease,
        disposition: "destroy",
      });
      expectOrder(order.join(""), /A.*B.*C/);
      if (result?.exitCode !== 0) throw new Error("streaming command failed");
    });
  }

  if (manifest.capabilities.timeout) {
    await run("timeout.terminates", async () => {
      const lease = await provider.acquireLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
      });
      const result = await provider.execute?.({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        lease,
        request: { command: "sleep", args: ["10"], timeoutMs: 200 },
      });
      await provider.releaseLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        lease,
        disposition: "destroy",
      });
      if (result?.status !== "timed_out")
        throw new Error(`expected timed_out, got ${result?.status}`);
    });
  }

  if (manifest.capabilities.cancellation) {
    await run("cancellation.cancels", async () => {
      const lease = await provider.acquireLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
      });
      const handle = await provider.startExecution({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        lease,
        request: { command: "sleep", args: ["10"] },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await handle.cancel("test");
      const result = await handle.wait();
      await provider.releaseLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        lease,
        disposition: "destroy",
      });
      if (result.status !== "cancelled" && result.status !== "failed") {
        throw new Error(`expected cancelled, got ${result.status}`);
      }
    });
  }

  if (manifest.capabilities.stdin || manifest.capabilities.signals) {
    await run("process.control.surface", async () => {
      const lease = await provider.acquireLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
      });
      const handle = await provider.startExecution({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        lease,
        request: { command: "sleep", args: ["1"] },
      });
      try {
        if (manifest.capabilities.stdin && (!handle.writeStdin || !handle.closeStdin)) {
          throw new Error("stdin capability requires writeStdin() and closeStdin()");
        }
        if (manifest.capabilities.signals && !handle.signal) {
          throw new Error("signals capability requires signal()");
        }
        await handle.cancel("capability surface check");
        await handle.wait();
      } finally {
        await provider.releaseLease({
          config: context.config,
          credentials: context.credentials ?? {},
          logger: nullLogger,
          lease,
          disposition: "destroy",
        });
      }
    });
  }

  if (manifest.capabilities.binaryFilesystem) {
    await run("filesystem.binaryRoundtrip", async () => {
      const lease = await provider.acquireLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
      });
      const fs = provider.filesystem?.(lease, {
        credentials: context.credentials ?? {},
        logger: nullLogger,
      });
      if (!fs) throw new Error("provider claims binaryFilesystem but has no filesystem()");
      const input = new Uint8Array(1024 * 8);
      for (let i = 0; i < input.byteLength; i += 1) input[i] = (i * 31) & 0xff;
      await fs.write("/tmp/aaspai-contract.bin", input);
      const output = await fs.read("/tmp/aaspai-contract.bin");
      assertBytesEqual(output, input, "binary roundtrip");
      await provider.releaseLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        lease,
        disposition: "destroy",
      });
    });
  }

  if (manifest.capabilities.reusableLease) {
    await run("lease.resumeById", async () => {
      const lease = await provider.acquireLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
      });
      if (!lease.providerLeaseId) throw new Error("no providerLeaseId");
      const resumed = await provider.resumeLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
      });
      if (resumed.status !== "resumed") {
        throw new Error(`resume expected resumed, got ${resumed.status}`);
      }
      await provider.releaseLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        lease,
        disposition: "destroy",
      });
    });

    await run("lease.expiredOnMissing", async () => {
      const resumed = await provider.resumeLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        providerLeaseId: "lease-does-not-exist-xyz",
        leaseMetadata: {},
      });
      if (resumed.status !== "expired") {
        throw new Error("expected expired for a missing lease");
      }
    });
  }

  if (manifest.capabilities.destroyById) {
    await run("lease.destroyById", async () => {
      const lease = await provider.acquireLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
      });
      if (!lease.providerLeaseId) throw new Error("no providerLeaseId");
      await provider.destroyLease({
        config: context.config,
        credentials: context.credentials ?? {},
        logger: nullLogger,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
      });
    });
  }

  return { passed, skipped, failed };
}

function expectOrder(actual: string, re: RegExp): void {
  if (!re.test(actual)) {
    throw new Error(`output ordering violated: ${JSON.stringify(actual)}`);
  }
}

const nullLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Convenience for the testing package: runs and asserts zero failures. */
export async function assertProviderContract(input: DefineProviderContractInput): Promise<void> {
  const result = await runProviderContract(input);
  if (result.failed.length > 0) {
    throw new Error(
      `provider contract failed: ${result.failed
        .map((f) => `${f.name}: ${f.error.message}`)
        .join("; ")}`,
    );
  }
}
