/**
 * Capability truth for a V2 runtime provider. A capability may be true
 * only after the provider contract suite proves it. Billing is not a
 * capability: it is per-run execution metadata, not a static provider
 * property.
 */
export interface RuntimeCapabilities {
  execute: boolean;
  streaming: boolean;
  stdin: boolean;
  cancellation: boolean;
  timeout: boolean;
  signals: boolean;
  reusableLease: boolean;
  hibernate: boolean;
  destroyById: boolean;
  binaryFilesystem: boolean;
  upload: boolean;
  download: boolean;
  workspaceIsolation: boolean;
  /** Provider can expose an authenticated, provider-owned private service URL. */
  privateEndpoints?: boolean;
  /** Provider can reconstruct a running process from RuntimeExecutionBinding. */
  processReattachment?: boolean;
}

export const EMPTY_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  execute: false,
  streaming: false,
  stdin: false,
  cancellation: false,
  timeout: false,
  signals: false,
  reusableLease: false,
  hibernate: false,
  destroyById: false,
  binaryFilesystem: false,
  upload: false,
  download: false,
  workspaceIsolation: false,
});

export type RuntimeLeaseModel = "none" | "ephemeral" | "reusable";

export type RuntimeProviderStatus = "ready" | "experimental" | "disabled";

export interface RuntimeProviderManifest {
  type: string;
  label: string;
  version: number;
  status: RuntimeProviderStatus;
  leaseModel: RuntimeLeaseModel;
  capabilities: RuntimeCapabilities;
}

export type RuntimeProviderType =
  | "local"
  | "docker"
  | "ssh"
  | "daytona"
  | "e2b"
  | "modal"
  | "novita"
  | "exe_dev"
  | "cloudflare"
  | "kubernetes";
