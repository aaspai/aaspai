import type { RuntimeProviderManifest } from "../../core/contracts/index.js";

export const cloudflareManifest: RuntimeProviderManifest = {
  type: "cloudflare",
  label: "Cloudflare Workers sandbox",
  version: 1,
  status: "experimental",
  leaseModel: "reusable",
  capabilities: {
    execute: true,
    streaming: false,
    stdin: true,
    cancellation: false,
    timeout: true,
    signals: false,
    reusableLease: true,
    hibernate: false,
    destroyById: true,
    binaryFilesystem: true,
    upload: true,
    download: true,
    workspaceIsolation: true,
  },
};
