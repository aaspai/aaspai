/**
 * B3.1: audit log helper.
 *
 * tRPC mutations call this to record who did what, when,
 * from where. The row is append-only; reads happen via
 * the auditLog schema.
 */
import { randomUUID } from "node:crypto";
import { db, schema } from "./index";

export type AuditAction =
  | "service.create"
  | "service.update"
  | "service.delete"
  | "service.deploy"
  | "service.getConnectionString"
  | "service.revealConnectionPassword"
  | "service.readSecrets"
  | "service.writeSecrets"
  | "org.createProject"
  | "org.updateProject"
  | "org.deleteProject"
  | "org.inviteMember"
  | "org.revokeInvitation"
  | "org.removeMember"
  | "org.updateMemberRole"
  | "org.createEnvironment"
  | "org.updateEnvironment"
  | "org.deleteEnvironment"
  | "org.cloneProject"
  | "org.archiveProject"
  | "org.restoreProject"
  | "git.connectGithub"
  | "git.disconnectConnection"
  | "infra.createSSHKey"
  | "infra.deleteSSHKey"
  | "infra.createServer"
  | "infra.deleteServer"
  | "infra.createRegistry"
  | "infra.deleteRegistry"
  | "api-key.create"
  | "api-key.revoke"
  | "2fa.enable"
  | "2fa.disable"
  | "work.table.create"
  | "work.field.create"
  | "work.record.create"
  | "work.record.update"
  | "work.record.archive"
  | "work.record.restore";

export interface AuditEventInput {
  organizationId: string;
  actorUserId: string | null;
  action: AuditAction;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/**
 * Fire-and-forget audit event writer. We don't await it
 * in the mutation path; a failure to write the audit row
 * should not roll back the user's change. A retry queue
 * (out of scope for B3) can pick up failed rows from
 * the metadata._failed_at field.
 */
export function audit(input: AuditEventInput): void {
  const row: typeof schema.auditLog.$inferInsert = {
    id: randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    metadata: input.metadata ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };
  // Best-effort: log on failure, don't throw.
  db.insert(schema.auditLog)
    .values(row)
    .then(
      () => {},
      (err) => {
        console.error("[audit] failed to write row:", err);
      },
    );
}

/**
 * Async variant of `audit`. Returns when the row is committed
 * (or when the insert fails). Use this when the caller needs to
 * verify the row exists before returning — e.g. the service-
 * secrets module, which fires `service.readSecrets` and then
 * the next read expects to find the row.
 */
export async function auditAsync(input: AuditEventInput): Promise<void> {
  const row: typeof schema.auditLog.$inferInsert = {
    id: randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    metadata: input.metadata ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };
  try {
    await db.insert(schema.auditLog).values(row);
  } catch (err) {
    console.error("[audit] failed to write row:", err);
  }
}
