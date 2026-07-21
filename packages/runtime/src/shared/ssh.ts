/**
 * SSH transport STUB. Will host the SSH round-trip pair
 * (prepareRuntimeForSshExecution + restoreRuntimeFromSshExecution) once
 * an adapter needs to run an agent on a remote host over ssh.
 *
 * For now the only SSH-adjacent surface is the spec validation in
 * `@aaspai/contracts/runtime` (sandbox + ssh execution targets).
 */

export const SSH_STUB_MESSAGE =
  "SSH transport is not yet implemented in @aaspai/runtime. Use the local target for now.";

export class SshTransportUnavailableError extends Error {
  readonly code = "AASPAI_SSH_UNAVAILABLE";
  constructor() {
    super(SSH_STUB_MESSAGE);
    this.name = "SshTransportUnavailableError";
  }
}
