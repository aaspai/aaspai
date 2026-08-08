import type { JsonObject } from "@aaspai/contracts";
import { z } from "zod";
import { sanitizeLeaseMetadata } from "../security/lease-metadata.js";
import type { RuntimeLeaseModel, RuntimeProviderManifest } from "./capabilities.js";
import type { RuntimeProvider } from "./provider.js";

export type { RuntimeLeaseModel, RuntimeProviderManifest } from "./capabilities.js";

/**
 * A serializable provider lease. This is the ONLY durable representation
 * of an environment. In-memory SDK objects are a cache and must never be
 * required for correctness.
 */
export interface RuntimeLease {
  version: 1;
  provider: string;
  providerLeaseId: string | null;
  reusable: boolean;
  createdAt: string;
  metadata: RuntimeLeaseMetadata;
}

/** Runtime leases cross worker/process boundaries as JSON. Keep a runtime
 * schema beside the type so stores can validate before persisting or
 * resuming a lease. Secrets are rejected by the metadata sanitizer before
 * this schema is reached. */
export const runtimeLeaseSchema = z
  .object({
    version: z.literal(1),
    provider: z.string().trim().min(1).max(128),
    providerLeaseId: z.string().trim().min(1).max(512).nullable(),
    reusable: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export function parseRuntimeLease(input: unknown): RuntimeLease {
  const parsed = runtimeLeaseSchema.parse(input) as RuntimeLease;
  const sanitized = sanitizeLeaseMetadata(parsed.metadata);
  if (sanitized.droppedKeys.length > 0) {
    throw new Error(
      `runtime lease metadata contains forbidden or non-serializable keys: ${sanitized.droppedKeys.join(", ")}`,
    );
  }
  return { ...parsed, metadata: sanitized.metadata as RuntimeLease["metadata"] };
}

export interface RuntimeLeaseMetadata {
  provider: string;
  remoteCwd?: string;
  shellCommand?: "bash" | "sh";
  region?: string;
  image?: string;
  resourceClass?: string;
  nativeState?: string;
  backend?: string;
  namespace?: string;
  podName?: string;
  resumed?: boolean;
  [key: string]: JsonValue | undefined;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type RuntimeResumeResult =
  | { status: "resumed"; lease: RuntimeLease }
  | { status: "expired"; reason?: string };

export type RuntimeReleaseDisposition = "retain" | "hibernate" | "destroy";

export type RuntimeReleaseOutcome = "retained" | "hibernated" | "destroyed";

export interface RuntimeReleaseResult {
  disposition: RuntimeReleaseOutcome;
  fallbackUsed?: boolean;
  warnings?: string[];
}

export interface RuntimeDestroyResult {
  destroyed: boolean;
  warnings?: string[];
}

export interface RuntimeWorkspace {
  cwd: string;
  metadata?: JsonObject;
}

/**
 * Validation of provider configuration. A provider that fails config
 * validation must not be probed or acquired.
 */
export interface RuntimeValidationResult<TConfig = unknown> {
  ok: true;
  normalizedConfig: TConfig;
}

export interface RuntimeValidationFailure {
  ok: false;
  errors: string[];
}

export type RuntimeValidationOutcome<TConfig = unknown> =
  | RuntimeValidationResult<TConfig>
  | RuntimeValidationFailure;

export interface RuntimeProbeResult {
  ok: boolean;
  summary?: string;
  metadata?: JsonObject;
  error?: string;
}

export interface RuntimeProviderDescriptor {
  manifest: RuntimeProviderManifest;
  load(): Promise<{ createProvider: RuntimeProviderFactory }>;
}

export type RuntimeProviderFactory = (
  input: RuntimeProviderFactoryInput,
) => Promise<RuntimeProvider>;

export interface RuntimeProviderFactoryInput {
  config: unknown;
  credentials?: RuntimeCredentialSet;
  logger?: RuntimeLogger;
  clock?: RuntimeClock;
  trace?: { executionId?: string; sessionId?: string };
}

export interface RuntimeClock {
  now(): Date;
}

export interface RuntimeCredentialSet {
  apiKey?: string;
  tokenId?: string;
  tokenSecret?: string;
  sshPrivateKey?: string;
  [key: string]: string | undefined;
}

export interface RuntimeLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function manifestLeaseModel(manifest: RuntimeProviderManifest): RuntimeLeaseModel {
  return manifest.leaseModel;
}
