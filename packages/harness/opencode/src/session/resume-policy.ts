import type { NativeSessionBinding } from "@aaspai/contracts/harness";

/**
 * Resume policy for the OpenCode server binding.
 *
 * The sessions/execution layer decides it wants to continue a logical session; the
 * adapter decides whether the *specific native session* it previously
 * returned is technically safe to resume on this execution. The policy
 * is pure — no I/O — so it is unit-testable.
 */
export type ResumeDecision =
  | { allowed: true; sessionId: string }
  | { allowed: false; reason: "runtime_changed" | "workspace_changed" | "session_missing" };

export interface ResumeContext {
  /** The execution identity the run will actually use. */
  runtimeKind?: string;
  /** The workspace cwd the run will actually use. */
  cwd: string;
}

/**
 * Decide whether the given native binding can be resumed here.
 *
 * A native session is only safe to resume when the runtime kind and the
 * workspace cwd match the run that produced the binding. A missing
 * binding means there is nothing to resume (`session_missing`).
 */
export function decideResume(
  binding: NativeSessionBinding | undefined,
  ctx: ResumeContext,
): ResumeDecision {
  if (!binding) return { allowed: false, reason: "session_missing" };
  if (binding.runtime?.kind && ctx.runtimeKind && binding.runtime.kind !== ctx.runtimeKind) {
    return { allowed: false, reason: "runtime_changed" };
  }
  if (binding.workspace?.cwd && binding.workspace.cwd !== ctx.cwd) {
    return { allowed: false, reason: "workspace_changed" };
  }
  return { allowed: true, sessionId: binding.nativeSessionId };
}
