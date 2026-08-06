import { getDefaultDb, runMigrations } from "@aaspai/db";
import { TelemetryRepository } from "@aaspai/telemetry";
import { ensureWorkspaceEnv, isAaspaiWorkspace } from "./aaspai";

/**
 * Web observer read model.
 *
 * The web app reads the observer through the same SQLite repository the
 * API uses. All queries are org-scoped to the local organization.
 */

export type ObserverRow = Record<string, unknown>;

let cachedRepo: TelemetryRepository | null = null;

function orgId(): string {
  return process.env.AASPAI_ORGANIZATION_ID ?? "org_local";
}

function repo(): TelemetryRepository | null {
  if (!isAaspaiWorkspace()) return null;
  ensureWorkspaceEnv();
  if (!cachedRepo) {
    const handle = getDefaultDb();
    runMigrations(handle);
    cachedRepo = new TelemetryRepository(handle);
  }
  return cachedRepo;
}

export function observerAvailable(): boolean {
  return repo() !== null;
}

export interface ObserverOverview {
  stats: ObserverRow;
  services: string[];
  recentLogs: ObserverRow[];
  sessions: ObserverRow[];
  ingestErrors: ObserverRow[];
  importFiles: number;
}

export function getObserverOverview(limit = 20): ObserverOverview {
  const r = repo();
  const org = orgId();
  if (!r) {
    return {
      stats: {},
      services: [],
      recentLogs: [],
      sessions: [],
      ingestErrors: [],
      importFiles: 0,
    };
  }
  return {
    stats: r.getStats(org),
    services: r.getServices(org),
    recentLogs: r.queryLogs({ organizationId: org, limit }).rows,
    sessions: r.querySessions({ organizationId: org, limit }).rows,
    ingestErrors: r.queryIngestErrors({ organizationId: org, limit: 10 }).rows,
    importFiles: r.listImportState(org).length,
  };
}

export function queryObserverLogs(params: {
  search?: string;
  provider?: string;
  sessionId?: string;
  executionId?: string;
  severity?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}) {
  const r = repo();
  const org = orgId();
  if (!r) return { rows: [], nextCursor: undefined, total: 0 };
  return r.queryLogs({ organizationId: org, ...params, limit: params.limit ?? 50 });
}

export function queryObserverTraces(params: {
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}) {
  const r = repo();
  const org = orgId();
  if (!r) return { rows: [], nextCursor: undefined, total: 0 };
  return r.queryTraces({ organizationId: org, ...params, limit: params.limit ?? 50 });
}

export function getObserverTrace(traceId: string) {
  const r = repo();
  if (!r) return [];
  return r.getTraceSpans(traceId, orgId());
}

export function getObserverMetricNames() {
  const r = repo();
  if (!r) return [];
  return r.getMetricNames(orgId());
}

export function getObserverMetricSeries(name: string, intervalSec = 60) {
  const r = repo();
  if (!r) return null;
  return r.getMetricSeries({
    organizationId: orgId(),
    name,
    intervalSec,
    from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  });
}

export function queryObserverSessions(params: {
  status?: string;
  provider?: string;
  from?: string;
  to?: string;
  limit?: number;
}) {
  const r = repo();
  const org = orgId();
  if (!r) return { rows: [], nextCursor: undefined, total: 0 };
  return r.querySessions({ organizationId: org, ...params, limit: params.limit ?? 50 });
}

export function getObserverSessionDetail(sessionId: string) {
  const r = repo();
  if (!r) return null;
  return r.getSessionDetail(sessionId, orgId());
}

export function getObserverCosts(
  groupBy: "provider" | "model" | "session" | "execution" | "user" | "day" = "provider",
) {
  const r = repo();
  if (!r) return [];
  return r.aggregateCosts({ organizationId: orgId(), groupBy });
}

export function getObserverDashboards() {
  const r = repo();
  if (!r) return [];
  return r.listDashboards(orgId());
}

export function getObserverDefaultDashboard() {
  const r = repo();
  if (!r) return null;
  return r.getDefaultDashboard(orgId());
}

export function getObserverImports() {
  const r = repo();
  if (!r) return [];
  return r.listImportState(orgId());
}
