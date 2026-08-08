import type { RuntimeProviderManifest } from "../../core/contracts/index.js";

export const daytonaManifest: RuntimeProviderManifest = {
  type: "daytona",
  label: "Daytona (development environment)",
  version: 1,
  status: "ready",
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
    privateEndpoints: true,
  },
};
