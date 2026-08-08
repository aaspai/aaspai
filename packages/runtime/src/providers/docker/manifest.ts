import type { RuntimeProviderManifest } from "../../core/contracts/index.js";

export const dockerManifest: RuntimeProviderManifest = {
  type: "docker",
  label: "Docker isolated environment",
  version: 1,
  status: "experimental",
  leaseModel: "ephemeral",
  capabilities: {
    execute: true,
    streaming: true,
    stdin: true,
    cancellation: true,
    timeout: true,
    signals: false,
    reusableLease: false,
    hibernate: false,
    destroyById: true,
    binaryFilesystem: true,
    upload: true,
    download: true,
    workspaceIsolation: true,
  },
};
