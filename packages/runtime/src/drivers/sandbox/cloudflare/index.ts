import type { RuntimeTarget } from "../../../shared/execution-target.js";

/**
 * Cloudflare sandbox driver. STUB for the foundation slice.
 *
 * Real impl uses the "bridge template" pattern: the operator deploys a
 * Cloudflare Worker to their own account that exposes a small REST surface
 * (`/api/aaspai-sandbox/v1/{health,probe,leases/*,exec}`) and a Durable
 * Object (`@cloudflare/sandbox`) inside. The plugin is just an HTTP
 * client to that Worker, with SSE streaming for `exec` calls.
 */

const STUB_MESSAGE =
  "cloudflare sandbox driver is a stub. Deploy the bridge Worker template and wire the HTTP client when you need it.";

export const cloudflareTarget: RuntimeTarget = {
  info: { kind: "sandbox", provider: "cloudflare", label: "Cloudflare", status: "stub" },
  async run() {
    throw new Error(STUB_MESSAGE);
  },
  async prepareWorkspace() {
    throw new Error(`${STUB_MESSAGE} (prepareWorkspace)`);
  },
  async restoreWorkspace() {
    throw new Error(`${STUB_MESSAGE} (restoreWorkspace)`);
  },
};
