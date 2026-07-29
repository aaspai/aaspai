import type { LoopPattern } from "@aaspai/contracts/phase2";
import type { DecideFn, ResolvedLoopPattern } from "../pattern.js";
import dailyTriageDecide from "./daily-triage/decide.js";
import dailyTriageDiscover from "./daily-triage/discover.js";
import {
  discoverChangelogWork,
  discoverCiFailures,
  discoverDependencyWork,
  discoverIssueWakeups,
  discoverPostMergeWork,
  discoverPrWork,
} from "./discover.js";

function reportDecide(): DecideFn {
  return async (item) => ({
    kind: "report",
    payload: {
      title: item.title,
      body: `Pattern: ${item.ref.kind}/${item.ref.id}\n\n${item.description ?? "Review this item."}`,
    },
  });
}

const BASE_PATTERN: Omit<LoopPattern, "id" | "title" | "description" | "timestamp"> = {
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
    ...BASE_PATTERN,
    id: "loop/daily-triage",
    title: "Daily Triage",
    description: "Morning scan of CI failures, open issues, and recent commits.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "cron", expression: "0 8 * * 1-5", timezone: "America/Los_Angeles" },
  },
  discover: dailyTriageDiscover,
  decide: dailyTriageDecide,
};

export const PR_BABYSITTER: ResolvedLoopPattern = {
  pattern: {
    ...BASE_PATTERN,
    id: "loop/pr-babysitter",
    title: "PR Babysitter",
    description: "Report repository work waiting on PR review, CI, rebase, or merge.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 900 },
  },
  discover: discoverPrWork,
  decide: reportDecide(),
};

export const CI_SWEEPER: ResolvedLoopPattern = {
  pattern: {
    ...BASE_PATTERN,
    id: "loop/ci-sweeper",
    title: "CI Sweeper",
    description: "Report recent CI, test, build, and pipeline failures.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 900 },
  },
  discover: discoverCiFailures,
  decide: reportDecide(),
};

export const DEPENDENCY_SWEEPER: ResolvedLoopPattern = {
  pattern: {
    ...BASE_PATTERN,
    id: "loop/dependency-sweeper",
    title: "Dependency Sweeper",
    description: "Report active dependency, package, CVE, and security work.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 21600 },
  },
  discover: discoverDependencyWork,
  decide: reportDecide(),
};

export const CHANGELOG_DRAFTER: ResolvedLoopPattern = {
  pattern: {
    ...BASE_PATTERN,
    id: "loop/changelog-drafter",
    title: "Changelog Drafter",
    description: "Report completed work from the last day for release notes.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 86400 },
  },
  discover: discoverChangelogWork,
  decide: reportDecide(),
};

export const POST_MERGE_CLEANUP: ResolvedLoopPattern = {
  pattern: {
    ...BASE_PATTERN,
    id: "loop/post-merge-cleanup",
    title: "Post-Merge Cleanup",
    description: "Report completed merge, cleanup, TODO, dead-code, and feature-flag work.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 21600 },
  },
  discover: discoverPostMergeWork,
  decide: reportDecide(),
};

export const ISSUE_TRIAGE: ResolvedLoopPattern = {
  pattern: {
    ...BASE_PATTERN,
    id: "loop/issue-triage",
    title: "Issue Triage",
    description: "Report queued and failed issue, bug, ticket, and incident wakeups.",
    timestamp: new Date().toISOString(),
    schedule: { kind: "interval", seconds: 7200 },
  },
  discover: discoverIssueWakeups,
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
