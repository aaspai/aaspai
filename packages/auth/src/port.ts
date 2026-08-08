import type { AuthVerificationResult } from "@aaspai/contracts";

/** Process-local input. The credential value is never part of a DTO/result. */
export interface AuthVerifyInput {
  credential?: {
    kind: "bearer" | "session";
    value: string;
  };
}

/** API-owned authentication/session verification port. */
export interface AuthVerifier {
  verify(input: AuthVerifyInput): Promise<AuthVerificationResult>;
}
