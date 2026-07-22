/**
 * The 7 starter patterns from loop-engineering, adapted for aaspai.
 *
 * Each is a `ResolvedLoopPattern` with a real (foundation-scope)
 * discover and decide. The actual session execution is wired via
 * `LoopRunner` in Phase 3.
 */

import type { LoopPattern, WorkItem } from "@aaspai/contracts/phase2";
import type { DecideFn, DiscoverFn, ResolvedLoopPattern } from "../pattern.js";
import dailyTriageDecide from "./daily-triage/decide.js";
import dailyTriageDiscover from "./daily-triage/discover.js";

function noopDiscover(): DiscoverFn {
  return async () => [] as readonly WorkItem[];
}

function reportDecide(): DecideFn {
  return async (item) => ({
    kind: "report",
    payload: {
      title: item.title,
      body: `Pattern: ${item.ref.kind}/${item.ref.id}\n\n_No decision logic implemented yet — this is a foundation stub._`,
    },
  });
}

const STUB_PATTERN: Omit<LoopPattern, "id" | "title" | "description" | "timestamp"> = {
  type: "LoopPattern",
  schedule: { kind: "manual" },
  agent: "agent/operator",
  autonomyLevel: "L1",
  status: "enabled",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  configJson: "{}",
  gateJson: "{}",
  budgetJson: "{}",
};

export const DAILY_TRIAGE: ResolvedLoopPattern = {
  pattern: {
    ...STUB_PATTERN,
    id: "loop/daily-triage",
    title: "Daily Triage",
    description: "Morning scan of CI failures, open issues, and recent commits → STATE.md.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "cron", expression: "0 8 * * 1-5", timezone: "America/Los_Angeles" },
  },
  discover: dailyTriageDiscover,
  decide: dailyTriageDecide,
};

export const PR_BABYSITTER: ResolvedLoopPattern = {
  pattern: {
    ...STUB_PATTERN,
    id: "loop/pr-babysitter",
    title: "PR Babysitter",
    description: "Herd PRs through review/CI/rebase/merge.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 900 },
  },
  discover: noopDiscover(),
  decide: reportDecide(),
};

export const CI_SWEEPER: ResolvedLoopPattern = {
  pattern: {
    ...STUB_PATTERN,
    id: "loop/ci-sweeper",
    title: "CI Sweeper",
    description: "React to red CI: classify (flake/regression/infra) → fix.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 900 },
  },
  discover: noopDiscover(),
  decide: reportDecide(),
};

export const DEPENDENCY_SWEEPER: ResolvedLoopPattern = {
  pattern: {
    ...STUB_PATTERN,
    id: "loop/dependency-sweeper",
    title: "Dependency Sweeper",
    description: "Patch + low-risk CVE bumps.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 21600 },
  },
  discover: noopDiscover(),
  decide: reportDecide(),
};

export const CHANGELOG_DRAFTER: ResolvedLoopPattern = {
  pattern: {
    ...STUB_PATTERN,
    id: "loop/changelog-drafter",
    title: "Changelog Drafter",
    description: "Scan merged PRs → draft release notes.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 86400 },
  },
  discover: noopDiscover(),
  decide: reportDecide(),
};

export const POST_MERGE_CLEANUP: ResolvedLoopPattern = {
  pattern: {
    ...STUB_PATTERN,
    id: "loop/post-merge-cleanup",
    title: "Post-Merge Cleanup",
    description: "After merges, scan for TODOs/dead code/stale flags.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 21600 },
  },
  discover: noopDiscover(),
  decide: reportDecide(),
};

export const ISSUE_TRIAGE: ResolvedLoopPattern = {
  pattern: {
    ...STUB_PATTERN,
    id: "loop/issue-triage",
    title: "Issue Triage",
    description: "Dedup + label + prioritize incoming issues.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 7200 },
  },
  discover: noopDiscover(),
  decide: reportDecide(),
};

export const STARTER_PATTERNS: readonly ResolvedLoopPattern[] = [
  DAILY_TRIAGE,
  PR_BABYSITTER,
  CI_SWEEPER,
  DEPENDENCY_SWEEPER,
  CHANGELOG_DRAFTER,
  POST_MERGE_CLEANUP,
  ISSUE_TRIAGE,
] as const;
