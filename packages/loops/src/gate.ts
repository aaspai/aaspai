/**
 * Gate — the path/action policy engine.
 *
 * Verifies a (action, paths) tuple against a `GatePolicy`. Uses
 * minimatch with `dot: true` so denylists correctly match dotfiles
 * (a common subtle bug).
 */
import { minimatch } from "minimatch";
import type { GateAction, GatePolicy } from "@aaspai/contracts/phase2";

export type GateCheckInput = {
  action: string;
  paths: readonly string[];
};

export type GateCheckResult =
  | { ok: true; action: GateAction }
  | { ok: false; reason: "denied_path" | "path_not_allowed" | "action_disallowed" | "max_files"; matchedPath?: string; requiresApproval?: "human" | "operator" | "supervisor" };

export class Gate {
  constructor(private readonly policy: GatePolicy) {}

  check(input: GateCheckInput): GateCheckResult {
    // 1. Denylist first (most specific / most dangerous)
    for (const path of input.paths) {
      for (const pattern of this.policy.denylist) {
        if (matchGlob(pattern, path)) {
          return { ok: false, reason: "denied_path", matchedPath: path };
        }
      }
    }

    // 2. Max files
    if (this.policy.maxFilesChanged > 0 && input.paths.length > this.policy.maxFilesChanged) {
      return { ok: false, reason: "max_files" };
    }

    // 3. Allowlist (if non-empty)
    if (this.policy.allowlist.length > 0) {
      const allAllowed = input.paths.every((p) =>
        this.policy.allowlist.some((pattern) => matchGlob(pattern, p)),
      );
      if (!allAllowed) {
        const matched = input.paths.find((p) =>
          this.policy.allowlist.some((pattern) => matchGlob(pattern, p)),
        );
        return { ok: false, reason: "path_not_allowed", matchedPath: matched };
      }
    }

    // 4. Action rules
    const actionRule = this.policy.actions[input.action];
    if (actionRule && !actionRule.allowed) {
      return {
        ok: false,
        reason: "action_disallowed",
        requiresApproval: actionRule.requireApproval,
      };
    }
    if (actionRule && actionRule.requireApproval) {
      return { ok: true, action: actionRule };
    }

    return { ok: true, action: actionRule ?? { allowed: true } };
  }
}

function matchGlob(pattern: string, path: string): boolean {
  return minimatch(path, pattern, { dot: true });
}
