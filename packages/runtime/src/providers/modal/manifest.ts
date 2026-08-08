import type { RuntimeProviderManifest } from "../../core/contracts/index.js";

export const modalManifest: RuntimeProviderManifest = {
  type: "modal",
  label: "Modal sandbox",
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
    hibernate: false, // Modal has no pause primitive; do not claim it.
    destroyById: true,
    binaryFilesystem: true,
    upload: true,
    download: true,
    workspaceIsolation: true,
  },
};
