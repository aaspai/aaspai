import type {
  Actor,
  IdentityVerificationResult,
  IdentityVerifyInput,
} from "@aaspai/contracts/identity";
import { IDENTITY_PROTOCOL_VERSION } from "@aaspai/contracts/identity";
import type { IdentityVerifier } from "../port";

/** Test-only credential fixture. Never use this adapter in production. */
export interface InMemoryCredentialFixture {
  token: string;
  actor: Actor;
  expiresAt?: Date;
  revoked?: boolean;
}

function failure(
  code: Extract<IdentityVerificationResult, { ok: false }>["code"],
): IdentityVerificationResult {
  return { ok: false, code };
}

function isMalformedCredential(value: unknown): boolean {
  return (
    typeof value !== "string" || value.length === 0 || value.length > 4096 || /\s/u.test(value)
  );
}

/**
 * Deterministic fake verifier for contract and API tests.
 * Keeps credentials private to the fixture map and never includes
 * them in a result, error, or serialization method.
 */
export class InMemoryIdentityVerifier implements IdentityVerifier {
  #fixtures = new Map<string, InMemoryCredentialFixture>();

  constructor(fixtures: readonly InMemoryCredentialFixture[] = []) {
    for (const fixture of fixtures) this.add(fixture);
  }

  add(fixture: InMemoryCredentialFixture): void {
    if (fixture.actor.protocolVersion !== IDENTITY_PROTOCOL_VERSION) {
      throw new TypeError("Invalid credential fixture: protocol version mismatch");
    }
    if (isMalformedCredential(fixture.token)) {
      throw new TypeError("Invalid credential fixture");
    }
    this.#fixtures.set(fixture.token, { ...fixture, actor: { ...fixture.actor } });
  }

  revoke(token: string): void {
    const fixture = this.#fixtures.get(token);
    if (fixture) fixture.revoked = true;
  }

  async verify(input: IdentityVerifyInput): Promise<IdentityVerificationResult> {
    if (!input.credential) return failure("missing_credential");
    if (input.credential.kind !== "bearer" && input.credential.kind !== "session") {
      return failure("malformed_credential");
    }
    if (isMalformedCredential(input.credential.value)) return failure("malformed_credential");

    const fixture = this.#fixtures.get(input.credential.value);
    if (!fixture) return failure("invalid_credential");
    if (fixture.revoked) return failure("revoked_credential");
    if (fixture.expiresAt && fixture.expiresAt.getTime() <= Date.now()) {
      return failure("expired_credential");
    }
    return { ok: true, actor: fixture.actor };
  }
}
