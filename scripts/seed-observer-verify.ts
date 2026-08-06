import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { createDb, runMigrations } from "@aaspai/db";
import {
  TelemetryRepository,
  ingestOtlpRequest,
  defaultLiveHub,
  newEventId,
} from "@aaspai/telemetry";

/**
 * Seeds a scratch workspace for HTTP-level observer verification:
 *  - a web-auth.json owner user + session (so the dashboard layout allows access);
 *  - a state.db with telemetry migrations + sample logs, spans, metrics, sessions;
 *  - a dashboard definition.
 *
 * Run: yarn tsx scripts/seed-observer-verify.ts <workspaceDir>
 */

const root = resolve(process.cwd(), "workspace", "observer-e2e");
const aaspaiDir = join(root, ".aaspai");
const org = "org_verify";

async function main(): Promise<void> {
  mkdirSync(aaspaiDir, { recursive: true });

  // Auth state (owner user + session)
  const salt = randomBytes(16).toString("hex");
  const passwordHash = scryptSync("verify-password", salt, 32).toString("hex");
  const user = {
  id: "user_verify",
  name: "Verify Owner",
  email: "verify@aaspai.local",
  salt,
  passwordHash,
  organizationId: org,
  companyName: "Aaspai Verify",
};
const token = randomBytes(32).toString("hex");
writeFileSync(
  join(aaspaiDir, "web-auth.json"),
  `${JSON.stringify(
    {
      users: [user],
      sessions: [{ token, userId: user.id, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }],
    },
    null,
    2,
  )}\n`,
);

// Database with telemetry
const dbPath = join(aaspaiDir, "state.db");
if (existsSync(dbPath)) {
  // fresh per run
}
process.env.AASPAI_DB = `sqlite:${dbPath}`;
const handle = createDb();
runMigrations(handle);
const repo = new TelemetryRepository(handle);
const now = new Date().toISOString();

repo.insertLogs([
  { id: newEventId("tlog"), organizationId: org, observedAt: now, receivedAt: now, provider: "claude-code", sourceKind: "aaspai_native", serviceName: "claude-code", eventName: "transcript.message", body: "hello from the seeded observer log", severityText: "INFO", severityNumber: 9, sessionId: "sess_verify", attributes: { "message.role": "user", "session.id": "sess_verify" }, dedupKey: "verify:log:1", rawAvailable: false },
  { id: newEventId("tlog"), organizationId: org, observedAt: now, receivedAt: now, provider: "runtime", sourceKind: "aaspai_native", serviceName: "runtime", eventName: "stderr", body: "a seeded error line", severityText: "ERROR", severityNumber: 17, sessionId: "sess_verify", attributes: { stream: "stderr" }, dedupKey: "verify:log:2", rawAvailable: false },
]);
repo.insertSpans([
  { id: newEventId("tsp"), organizationId: org, observedAt: now, receivedAt: now, provider: "codex_cli_rs", sourceKind: "aaspai_native", serviceName: "codex_cli_rs", traceId: "verifytrace1", spanId: "verify-span-1", name: "verify-root", status: "ok", startTime: now, endTime: now, rawAvailable: false },
  { id: newEventId("tsp"), organizationId: org, observedAt: now, receivedAt: now, provider: "codex_cli_rs", sourceKind: "aaspai_native", serviceName: "codex_cli_rs", traceId: "verifytrace1", spanId: "verify-span-2", parentSpanId: "verify-span-1", name: "verify-child", status: "ok", startTime: now, endTime: now, rawAvailable: false },
]);
repo.insertMetrics([
  { id: newEventId("tmet"), organizationId: org, observedAt: now, receivedAt: now, provider: "claude-code", sourceKind: "aaspai_native", serviceName: "claude-code", name: "claude_code.token.usage", metricType: "sum", sessionId: "sess_verify", model: "claude-sonnet-4-5", value: 500, attributes: { type: "input", model: "claude-sonnet-4-5" }, dedupKey: "verify:metric:1", rawAvailable: false },
  { id: newEventId("tmet"), organizationId: org, observedAt: now, receivedAt: now, provider: "claude-code", sourceKind: "aaspai_native", serviceName: "claude-code", name: "claude_code.cost.usage", metricType: "sum", sessionId: "sess_verify", model: "claude-sonnet-4-5", value: 0.003, attributes: { model: "claude-sonnet-4-5" }, dedupKey: "verify:metric:2", rawAvailable: false },
]);
repo.upsertSessionSummary({
  id: "tsess_sess_verify",
  organizationId: org,
  provider: "claude-code",
  sessionId: "sess_verify",
  firstSeenAt: now,
  lastSeenAt: now,
  status: "succeeded",
  model: "claude-sonnet-4-5",
  messageCount: 2,
  toolCallCount: 0,
  costUsd: 0.003,
});
repo.insertTranscriptMessages([
  { id: "tmsg_1", organizationId: org, sessionId: "sess_verify", seq: 0, ts: now, role: "user", kind: "transcript.message", text: "hello from the seeded observer log", attributes: {} },
  { id: "tmsg_2", organizationId: org, sessionId: "sess_verify", seq: 1, ts: now, role: "system", kind: "stderr", text: "a seeded error line", attributes: {} },
]);
repo.createDashboard({
  organizationId: org,
  name: "Verify Dashboard",
  description: "Seeded for HTTP verification",
  isDefault: true,
});
  await handle.close();

  console.log(JSON.stringify({ workspace: root, db: dbPath, org, cookieToken: token }, null, 2));
}

void main();

