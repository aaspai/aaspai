import type { RuntimeProviderManifest } from "../../core/contracts/index.js";

export const exeDevManifest: RuntimeProviderManifest = {
  type: "exe_dev",
  label: "exe.dev SSH visitor",
  version: 1,
  status: "experimental",
  leaseModel: "reusable",
  capabilities: {
    execute: true,
    streaming: true,
    stdin: true,
    cancellation: true,
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
