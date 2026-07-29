import type { WorkItem } from "@aaspai/contracts/phase2";
import {
  and,
  desc,
  eq,
  executionWorkItems,
  getDefaultDb,
  gte,
  inArray,
  sessions,
  wakeups,
} from "@aaspai/db";
import type { DiscoverFn } from "../pattern.js";

const ACTIVE = ["proposed", "ready", "running", "awaiting_verification", "awaiting_approval"];

export const discoverPrWork = workItemDiscovery(
  /\b(pr|pull request|review|rebase|merge)\b/i,
  ACTIVE,
);
export const discoverDependencyWork = workItemDiscovery(
  /\b(dependenc|package|upgrade|cve|security)\w*/i,
  ACTIVE,
);
export const discoverChangelogWork = workItemDiscovery(
  null,
  ["completed", "verified", "approved"],
  1,
);
export const discoverPostMergeWork = workItemDiscovery(
  /\b(merge|cleanup|todo|dead code|feature flag)\w*/i,
  ["completed", "verified", "approved"],
);

export const discoverCiFailures: DiscoverFn = async (_state, ctx) => {
  const rows = await getDefaultDb()
    .db.select()
    .from(sessions)
    .where(
      and(
        eq(sessions.organizationId, ctx.organizationId),
        eq(sessions.status, "failed"),
        gte(sessions.finishedAt, daysAgo(ctx.now, 7)),
      ),
    )
    .orderBy(desc(sessions.finishedAt))
    .limit(20);
  return rows
    .filter((row) => /\b(ci|test|build|pipeline|check)\w*/i.test(row.errorMessage ?? ""))
    .map(
      (row): WorkItem => ({
        ref: { kind: "session", id: row.id },
        title: `CI-related session failure: ${row.errorCode ?? row.id}`,
        description: row.errorMessage ?? "Session failed without an error message.",
        discoveredAt: ctx.now.toISOString(),
      }),
    );
};

export const discoverIssueWakeups: DiscoverFn = async (_state, ctx) => {
  const rows = await getDefaultDb()
    .db.select()
    .from(wakeups)
    .where(
      and(
        eq(wakeups.organizationId, ctx.organizationId),
        inArray(wakeups.status, ["queued", "failed"]),
        gte(wakeups.requestedAt, daysAgo(ctx.now, 7)),
      ),
    )
    .orderBy(desc(wakeups.requestedAt))
    .limit(20);
  return rows
    .filter((row) => /\b(issue|bug|ticket|incident)\w*/i.test(`${row.reason} ${row.triggerDetail}`))
    .map(
      (row): WorkItem => ({
        ref: { kind: "wakeup", id: row.id },
        title: row.reason ?? `Issue-related wakeup ${row.id}`,
        description: row.error ?? row.triggerDetail ?? "Issue requires triage.",
        discoveredAt: ctx.now.toISOString(),
      }),
    );
};

function workItemDiscovery(pattern: RegExp | null, statuses: string[], recentDays = 7): DiscoverFn {
  return async (_state, ctx) => {
    const rows = await getDefaultDb()
      .db.select()
      .from(executionWorkItems)
      .where(
        and(
          eq(executionWorkItems.organizationId, ctx.organizationId),
          inArray(executionWorkItems.status, statuses),
          gte(executionWorkItems.updatedAt, daysAgo(ctx.now, recentDays)),
        ),
      )
      .orderBy(desc(executionWorkItems.updatedAt))
      .limit(20);
    return rows
      .filter((row) => !pattern || pattern.test(`${row.title} ${row.description}`))
      .map(
        (row): WorkItem => ({
          ref: { kind: "work_item", id: row.id },
          title: row.title,
          description: `${row.status}: ${row.description || "No description."}`,
          discoveredAt: ctx.now.toISOString(),
        }),
      );
  };
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}
