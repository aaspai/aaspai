/**
 * Canonical scope hierarchy for AASPAI API authorization.
 *
 * B2: Consolidates the two divergent `hasScope` implementations (one in
 * `packages/auth/src/port.ts`, one in `apps/web/app/api/v1/_lib/auth.ts`)
 * into a single authoritative source.
 *
 * Hierarchy:
 * - `write` includes EVERYTHING (read, read.history, deploy).
 * - `deploy` includes read + deploy (for CI pipelines that need to read
 *   service state and trigger deploys, but shouldn't access deployment
 *   history).
 * - `read` includes only live reads (service list, environment list).
 * - `read.history` includes only deployment history reads.
 */

import type { ApiScope } from "@aaspai/contracts";

const SCOPE_HIERARCHY: Record<ApiScope, readonly ApiScope[]> = {
  read: ["read"],
  "read.history": ["read", "read.history"],
  write: ["read", "read.history", "write", "deploy"],
  deploy: ["deploy"],
};

/**
 * Check whether a set of granted scopes satisfies a required scope.
 *
 * A granted scope implicitly satisfies any required scope that is at or
 * below it in the hierarchy. For example:
 * - `["write"]` satisfies `read`, `read.history`, `write`, and `deploy`.
 * - `["deploy"]` satisfies only `deploy` (not read or read.history).
 * - `["read"]` satisfies only `read`.
 * - `["read.history"]` satisfies `read` and `read.history`.
 */
export function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  return granted.some((g) => SCOPE_HIERARCHY[g]?.includes(required) ?? false);
}
