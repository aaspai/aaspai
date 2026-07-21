/**
 * STUB for the foundation slice.
 *
 * Will host the run-log stream factory — `createSandboxRunLogTailFactory` —
 * that tees a sandboxed agent CLI's stdout/stderr to disk during execution
 * and lets the host tail those files to stream logs in near-real-time
 * (since batch RPCs only return output at exit).
 *
 * Real implementation lands once an actual sandbox driver needs it.
 */

export const RUN_LOG_STREAM_STUB_MESSAGE =
  "Run-log stream factory is not yet implemented in @aaspai/runtime. " +
  "It will land with the first real sandbox driver integration.";

export function createSandboxRunLogTailFactory(): never {
  throw new Error(RUN_LOG_STREAM_STUB_MESSAGE);
}
