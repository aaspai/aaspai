import { randomUUID } from "node:crypto";
import { AUDIT_PROTOCOL_VERSION, type AuditEvent } from "@aaspai/contracts/audit";
import type { AuditStore } from "./port";

export interface LoginAttemptRecord {
  email: string;
  ipAddress: string | null;
  userId: string | null;
  organizationId: string | null;
  result:
    | "success"
    | "invalid_password"
    | "invalid_email"
    | "locked_out"
    | "rate_limited"
    | "email_not_verified";
  userAgent: string | null;
}

/**
 * Create a login attempt recorder backed by an AuditStore.
 * Replaces the fire-and-forget `db.insert(schema.loginAttempt)` pattern
 * with an immutable audit write. The returned function swallows write
 * errors (logs them) so sign-in is never blocked by audit failure.
 */
export function createLoginAttemptRecorder(store: AuditStore) {
  return (input: LoginAttemptRecord): void => {
    const event: AuditEvent = {
      protocolVersion: AUDIT_PROTOCOL_VERSION,
      id: randomUUID(),
      organizationId: input.organizationId ?? "unknown",
      correlationId: `login-${randomUUID()}`,
      actorId: input.userId ?? "unknown",
      action: `user.signin.${input.result}`,
      targetType: "user",
      targetId: input.userId ?? undefined,
      occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      metadata: {
        email: input.email,
        ip: input.ipAddress,
        result: input.result,
        userAgent: input.userAgent,
      },
    };
    store.append(event).catch((err: unknown) => {
      console.error(
        "[login-attempt] audit write failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  };
}
