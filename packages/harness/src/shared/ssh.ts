/**
 * SSH transport for adapters. STUB for the foundation slice.
 *
 * Will host `prepareRuntimeForSshExecution` and
 * `restoreRuntimeFromSshExecution` round-trip helpers — the analog
 * of paperclip's `@paperclipai/adapter-utils/ssh.ts` prepare/restore
 * pair. Lives in `@aaspai/harness` for now so adapters that want to
 * opt in early can do so without a second package boundary.
 *
 * Real implementation is deferred until an adapter actually needs it.
 */

export const SSH_STUB_MESSAGE =
  "SSH transport is not yet implemented in @aaspai/harness. Use the local target for now.";

export class SshTransportUnavailableError extends Error {
  readonly code = "AASPAI_SSH_UNAVAILABLE";
  constructor() {
    super(SSH_STUB_MESSAGE);
    this.name = "SshTransportUnavailableError";
  }
}

export function ensureSshTransportAvailable(): never {
  throw new SshTransportUnavailableError();
}
