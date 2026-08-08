import type { RuntimeProviderManifest } from "../../core/contracts/index.js";

export const e2bManifest: RuntimeProviderManifest = {
  type: "e2b",
  label: "e2b (Firecracker microVM)",
  version: 1,
  status: "experimental",
  leaseModel: "reusable",
  capabilities: {
    execute: true,
    streaming: true,
    stdin: true,
    cancellation: true,
    timeout: true,
    signals: true,
    reusableLease: true,
    hibernate: true,
    destroyById: true,
    binaryFilesystem: true,
    upload: true,
    download: true,
    workspaceIsolation: true,
  },
};
