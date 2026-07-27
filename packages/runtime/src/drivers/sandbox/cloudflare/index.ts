import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTarget } from "../../../shared/execution-target.js";
import { CloudflareSandboxDriver } from "../../../shared/providers/cloudflare-driver.js";
import { createSdkSandboxTarget } from "../../../shared/sdk-sandbox-target.js";

/**
 * Cloudflare Workers Sandbox. Real impl uses a Cloudflare Worker
 * (the "bridge template") deployed to `<account>.workers.dev` that
 * exposes a 6-method `SandboxClient` REST surface. Each sandbox
 * maps to a Durable Object instance.
 *
 * Set `AASPAI_CF_BRIDGE_URL` (and optionally `AASPAI_CF_BRIDGE_TOKEN`)
 * to point at the deployed Worker. The test runner treats "bridgeUrl
 * required" as `skipped`.
 *
 * The driver is built lazily because the constructor throws when
 * the bridge URL isn't configured — that throw should happen at
 * `run` time, not at module-load time.
 */
const CLOUDFLARE_CAPABILITIES: ProviderCapabilities = {
  execute: true,
  streaming: true,
  cancellation: true,
  timeout: true,
  workspaceIsolation: true,
  restore: false,
  resume: false,
  artifacts: true,
  billing: "metered_api",
};

function buildCloudflareTarget(): RuntimeTarget {
  return createSdkSandboxTarget({
    driver: new CloudflareSandboxDriver(),
    providerKey: "cloudflare",
    label: "Cloudflare Workers sandbox",
    capabilities: CLOUDFLARE_CAPABILITIES,
  });
}

export const cloudflareTarget: RuntimeTarget = buildCloudflareTarget();
