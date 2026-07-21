/**
 * Budget enforcer — soft/hard token caps.
 *
 * Tracks token usage and cost per scope (loop / agent / org). The
 * soft cap (default 80% of daily) switches the loop to report-only.
 * The hard cap (default 100%) trips the kill switch.
 */
import type { Budget } from "@aaspai/contracts/phase2";

export interface BudgetStatus {
  tokensUsed: number;
  tokensCap: number;
  costUsd: number;
  costUsdCap: number;
  runs: number;
  runsCap: number;
  softReached: boolean;
  hardReached: boolean;
  percent: number;
  recommendation: "ok" | "report_only" | "kill_switch";
}

export class BudgetEnforcer {
  private readonly entries: Array<{
    scope: string;
    scopeId: string;
    window: string;
    tokens: number;
    costUsd: number;
    runs: number;
    ts: string;
  }> = [];

  constructor(private readonly budget: Budget) {}

  record(input: { scope: string; scopeId: string; window: string; tokens: number; costUsd: number; runs?: number }): void {
    this.entries.push({
      scope: input.scope,
      scopeId: input.scopeId,
      window: input.window,
      tokens: input.tokens,
      costUsd: input.costUsd,
      runs: input.runs ?? 1,
      ts: new Date().toISOString(),
    });
  }

  status(scope: string, scopeId: string, window: string): BudgetStatus {
    const matching = this.entries.filter((e) => e.scope === scope && e.scopeId === scopeId && e.window === window);
    const tokens = matching.reduce((s, e) => s + e.tokens, 0);
    const costUsd = matching.reduce((s, e) => s + e.costUsd, 0);
    const runs = matching.reduce((s, e) => s + e.runs, 0);

    const tokensCap = this.budget.perDay?.tokens ?? 0;
    const costUsdCap = this.budget.perDay?.costUsd ?? 0;
    const runsCap = this.budget.perDay?.runs ?? 0;
    const percent = tokensCap > 0 ? tokens / tokensCap : 0;
    const softReached = percent >= this.budget.soft;
    const hardReached = percent >= this.budget.hard;

    let recommendation: BudgetStatus["recommendation"] = "ok";
    if (hardReached) recommendation = "kill_switch";
    else if (softReached) recommendation = "report_only";

    return {
      tokensUsed: tokens,
      tokensCap,
      costUsd,
      costUsdCap,
      runs,
      runsCap,
      softReached,
      hardReached,
      percent,
      recommendation,
    };
  }
}

export function dailyWindow(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function monthlyWindow(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}
