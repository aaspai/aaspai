/**
 * STUB for the foundation slice. Mirrors the intent of paperclip's
 * `workspace-restore-merge.ts` and the `prepareWorkspaceForSshExecution`
 * / `restoreWorkspaceFromSshExecution` round-trip pair, but real
 * implementation is deferred to L3.
 *
 * The function shape is stable so callers can adopt the API now and
 * we fill the body in once an L3 consumer (a session controller) lands.
 */

export interface PrepareWorkspaceOptions {
  spec: unknown;
  localDir: string;
  remoteDir: string;
  onProgress?: (update: { transferredBytes: number; totalBytes?: number }) => void;
}

export interface RestoreWorkspaceOptions {
  spec: unknown;
  localDir: string;
  remoteDir: string;
  onProgress?: (update: { transferredBytes: number; totalBytes?: number }) => void;
}

export const WORKSPACE_ROUNDTRIP_STUB_MESSAGE =
  "prepareRuntimeForExecution / restoreRuntimeFromExecution are not yet implemented in @aaspai/runtime. " +
  "Use the local target for now; the round-trip lands in the L3 session-control slice.";

export async function prepareRuntimeForExecution(
  _options: PrepareWorkspaceOptions,
): Promise<void> {
  throw new Error(WORKSPACE_ROUNDTRIP_STUB_MESSAGE);
}

export async function restoreRuntimeFromExecution(
  _options: RestoreWorkspaceOptions,
): Promise<void> {
  throw new Error(WORKSPACE_ROUNDTRIP_STUB_MESSAGE);
}
