import type { RuntimeProviderManifest } from "../../core/contracts/index.js";

export const novitaManifest: RuntimeProviderManifest = {
  type: "novita",
  label: "Novita GPU instance",
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
