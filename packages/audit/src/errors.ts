/**
 * Errors thrown by audit store operations.
 */
export class AuditError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? `Audit error: ${code}`);
    this.name = "AuditError";
    this.code = code;
  }
}

/**
 * Thrown when attempting to modify or delete an existing
 * audit event (violates immutability).
 */
export class AuditImmutabilityError extends AuditError {
  constructor(eventId: string) {
    super("IMMUTABILITY_VIOLATION", `Audit event ${eventId} cannot be modified or deleted`);
    this.name = "AuditImmutabilityError";
  }
}

/**
 * Thrown when the audit store fails to persist an event.
 */
export class AuditStorageError extends AuditError {
  constructor(message: string) {
    super("STORAGE_FAILURE", message);
    this.name = "AuditStorageError";
  }
}
