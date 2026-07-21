import {
  type AuthPrincipal,
  type AuthVerificationResult,
  authPrincipalSchema,
} from "@aaspai/contracts";
import type { AuthVerifier, AuthVerifyInput } from "./port";

/** Test-only credential fixture. Never use this adapter in production. */
export interface InMemoryCredentialFixture {
  token: string;
  principal: AuthPrincipal;
  expiresAt?: Date;
  revoked?: boolean;
}

function failure(
  code: Extract<AuthVerificationResult, { ok: false }>["code"],
): AuthVerificationResult {
  return { ok: false, code };
}

function isMalformedCredential(value: unknown): boolean {
  return (
    typeof value !== "string" || value.length === 0 || value.length > 4096 || /\s/u.test(value)
  );
}

/**
 * Deterministic fake verifier for contract and API tests. It intentionally
 * keeps credentials private to the fixture map and never includes them in a
 * result, error, or serialization method.
 */
export class InMemoryAuthVerifier implements AuthVerifier {
  #fixtures = new Map<string, InMemoryCredentialFixture>();

  constructor(fixtures: readonly InMemoryCredentialFixture[] = []) {
    for (const fixture of fixtures) this.add(fixture);
  }

  add(fixture: InMemoryCredentialFixture): void {
    const principal = authPrincipalSchema.parse(fixture.principal);
    if (isMalformedCredential(fixture.token)) throw new TypeError("Invalid credential fixture");
    this.#fixtures.set(fixture.token, { ...fixture, principal });
  }

  revoke(token: string): void {
    const fixture = this.#fixtures.get(token);
    if (fixture) fixture.revoked = true;
  }

  async verify(input: AuthVerifyInput): Promise<AuthVerificationResult> {
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
    return { ok: true, principal: fixture.principal };
  }
}
