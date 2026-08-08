import type { RuntimeProviderManifest } from "../../core/contracts/index.js";

export const sshManifest: RuntimeProviderManifest = {
  type: "ssh",
  label: "SSH (remote host)",
  version: 1,
  status: "experimental",
  leaseModel: "ephemeral",
  capabilities: {
    execute: true,
    streaming: true,
    stdin: true,
    cancellation: false, // remote process-group cancellation not proven
    timeout: true,
    signals: false,
    reusableLease: false,
    hibernate: false,
    destroyById: false,
    binaryFilesystem: true,
    upload: true,
    download: true,
    workspaceIsolation: true,
  },
};
