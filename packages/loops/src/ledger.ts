/**
 * Circuit breaker — the "should I keep going?" check.
 *
 * Four-tier trip conditions, checked in order (most specific first):
 *  1. Stagnation    — same error signature N× in a row
 *  2. No progress   — N consecutive failures with no success in between
 *  3. Budget        — cumulative tokens reach the cap
 *  4. Max iters     — hard count cap
 *
 * Error signatures are normalized (timestamps → `<ts>`, paths →
 * basename, etc.) and compared with Jaccard similarity over
 * character trigrams. This catches "the same error recurring"
 * even when the messages differ in cosmetic ways.
 */
import type { CircuitDecision, CircuitPolicy, LedgerAttempt } from "@aaspai/contracts/phase2";

export class CircuitBreaker {
  constructor(private readonly policy: CircuitPolicy) {}

  shouldContinue(attempts: readonly LedgerAttempt[]): CircuitDecision {
    if (attempts.length === 0) return { kind: "continue" };

    // 1. Stagnation: same normalized signature N× in a row
    const stagThreshold = this.policy.stagnationThreshold;
    if (stagThreshold > 0 && attempts.length >= stagThreshold) {
      const last = attempts[attempts.length - 1]!;
      if (last.outcome === "failure" && last.error) {
        const sig = last.error.signature;
        let runLen = 1;
        for (let i = attempts.length - 2; i >= 0; i--) {
          const a = attempts[i]!;
          if (
            a.outcome === "failure" &&
            a.error &&
            signatureSimilarity(sig, a.error.signature) >= 0.85
          ) {
            runLen++;
          } else break;
        }
        if (runLen >= stagThreshold) {
          return {
            kind: "escalate",
            reason: "stagnation",
            summary: `Same error signature repeated ${runLen} times`,
          };
        }
      }
    }

    // 2. No progress: N consecutive failures
    const noProg = this.policy.noProgressThreshold;
    if (noProg > 0 && attempts.length >= noProg) {
      const lastN = attempts.slice(-noProg);
      if (lastN.every((a) => a.outcome === "failure")) {
        return {
          kind: "escalate",
          reason: "no_progress",
          summary: `${noProg} consecutive failures`,
        };
      }
    }

    // 3. Max iterations
    if (this.policy.maxIterations > 0 && attempts.length >= this.policy.maxIterations) {
      return {
        kind: "escalate",
        reason: "max_iterations",
        summary: `Hit max iterations ${this.policy.maxIterations}`,
      };
    }

    // 4. Budget (per-run from policy)
    if (
      this.policy.budgetOverride?.perRun?.tokens &&
      this.policy.budgetOverride.perRun.tokens > 0
    ) {
      const cap = this.policy.budgetOverride.perRun.tokens;
      const used = attempts.reduce((s, a) => s + (a.tokensUsed ?? 0), 0);
      if (used >= cap) {
        return { kind: "escalate", reason: "budget", summary: `Tokens used ${used} >= cap ${cap}` };
      }
    }

    return { kind: "continue" };
  }
}

export function normalizeError(input: string): string {
  return input
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/:\d{2,5}\b/g, ":<port>")
    .replace(/\/[^\s/]+/g, (m) => {
      const base = m.split(/[\\/]/).pop();
      return base ? `/${base}` : m;
    })
    .replace(/\d+/g, "#")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function signatureSimilarity(a: string, b: string): number {
  const aSig = normalizeError(a);
  const bSig = normalizeError(b);
  if (aSig === bSig) return 1;
  const aTri = trigrams(aSig);
  const bTri = trigrams(bSig);
  if (aTri.size === 0 && bTri.size === 0) return 0;
  let inter = 0;
  for (const t of aTri) if (bTri.has(t)) inter++;
  const union = aTri.size + bTri.size - inter;
  return union === 0 ? 0 : inter / union;
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 3) {
    out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return out;
}
