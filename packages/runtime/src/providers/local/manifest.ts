import type { RuntimeCapabilities, RuntimeProviderManifest } from "../../core/contracts/index.js";

export const localManifest: RuntimeProviderManifest = {
  type: "local",
  label: "Local",
  version: 1,
  status: "ready",
  leaseModel: "none",
  capabilities: {
    execute: true,
    streaming: true,
    stdin: true,
    cancellation: true,
    timeout: true,
    signals: true,
    reusableLease: false,
    hibernate: false,
    destroyById: false,
    binaryFilesystem: true,
    upload: true,
    download: true,
    workspaceIsolation: false,
    privateEndpoints: true,
  } satisfies RuntimeCapabilities,
};
