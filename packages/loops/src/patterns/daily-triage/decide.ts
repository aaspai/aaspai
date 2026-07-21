/**
 * decide.ts — for each work item, return report / act / escalate / noop.
 *
 *   - failed sessions:   act (delegate to operator for re-investigation)
 *   - succeeded sessions: report (highlight in STATE.md)
 *   - failed wakeups:     report (log for visibility, no auto-fix)
 *   - everything else:    noop
 */
import type { DecideFn } from "@aaspai/loops/pattern";
import type { WorkItem, DecideResult } from "@aaspai/contracts/phase2";

const decide: DecideFn = (async (item: WorkItem): Promise<DecideResult> => {
  const data = (item.data ?? {}) as { kind?: string; status?: string; errorMessage?: string; error?: string };

  if (data.kind === "session" && data.status === "failed") {
    return {
      kind: "act",
      reason: `session failed: ${data.errorMessage ?? "(no message)"}`,
    };
  }

  if (data.kind === "session" && data.status === "succeeded") {
    return {
      kind: "report",
      payload: {
        title: `Session succeeded`,
        body: item.description ?? "(no description)",
      },
    };
  }

  if (data.kind === "wakeup" && (data.status === "failed" || data.status === "cancelled")) {
    return {
      kind: "report",
      payload: {
        title: `Wakeup ${data.status}`,
        body: `error: ${data.error ?? "(none)"}`,
      },
    };
  }

  return { kind: "noop" };
}) as DecideFn;

export default decide;

