import type { Actor, ActorType } from "@aaspai/contracts/identity";
import { IDENTITY_PROTOCOL_VERSION } from "@aaspai/contracts/identity";

/**
 * Create a test actor fixture.
 */
export function createActorFixture(overrides?: {
  id?: string;
  type?: ActorType;
  organizationId?: string;
  displayName?: string;
}): Actor {
  return {
    protocolVersion: IDENTITY_PROTOCOL_VERSION,
    id: overrides?.id ?? `test-actor-${Math.random().toString(36).slice(2, 8)}`,
    type: overrides?.type ?? "human",
    organizationId: overrides?.organizationId ?? "test-org",
    displayName: overrides?.displayName ?? "Test User",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a test organization context fixture.
 */
export function createOrganizationFixture(overrides?: {
  id?: string;
  name?: string;
  slug?: string;
}): { id: string; name: string; slug: string } {
  const id = overrides?.id ?? `org-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: overrides?.name ?? "Test Organization",
    slug: overrides?.slug ?? `test-org-${id.slice(0, 6)}`,
  };
}
