import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX, generateApiKey, validateApiKey } from "../src/api-keys";
import type { ApiKeyRepository } from "../src/port";

function createMockRepository(): ApiKeyRepository & {
  insert: (
    hash: string,
    value: {
      id: string;
      userId: string;
      organizationId: string;
      scopes: string[];
      createdByUserId: string | null;
      expiresAt: Date | null;
      revokedAt: Date | null;
    },
  ) => void;
} {
  const store = new Map<
    string,
    {
      id: string;
      userId: string;
      organizationId: string;
      scopes: string[];
      createdByUserId: string | null;
      expiresAt: Date | null;
      revokedAt: Date | null;
    }
  >();
  return {
    findByHash: async (hash: string) => store.get(hash) ?? null,
    touchLastUsed: async (_id: string) => {},
    insert: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("generateApiKey", () => {
  it("generates a key with the correct prefix", () => {
    const { plain } = generateApiKey();
    expect(plain.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it("generates a key with a hash", () => {
    const { plain, hash } = generateApiKey();
    expect(hash.length).toBeGreaterThan(0);
    expect(plain).not.toBe(hash);
  });

  it("generates unique keys", () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1.plain).not.toBe(key2.plain);
    expect(key1.hash).not.toBe(key2.hash);
  });

  it("generates keys of sufficient length", () => {
    const { plain } = generateApiKey();
    expect(plain.length).toBeGreaterThan(40);
  });
});

describe("validateApiKey", () => {
  it("returns null for non-matching prefix", async () => {
    const repo = createMockRepository();
    const result = await validateApiKey(repo, "invalid-key");
    expect(result).toBeNull();
  });

  it("returns null for unknown key", async () => {
    const repo = createMockRepository();
    const result = await validateApiKey(repo, `${API_KEY_PREFIX}some-unknown-key`);
    expect(result).toBeNull();
  });

  it("returns key context for a valid key", async () => {
    const repo = createMockRepository();
    const { plain, hash, id } = generateApiKey();
    repo.insert(hash, {
      id,
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["read", "write"],
      createdByUserId: "user-1",
      expiresAt: null,
      revokedAt: null,
    });
    const result = await validateApiKey(repo, plain);
    expect(result).not.toBeNull();
    expect(result!.apiKeyId).toBe(id);
    expect(result!.organizationId).toBe("org-1");
  });

  it("returns null for a revoked key", async () => {
    const repo = createMockRepository();
    const { plain, hash, id } = generateApiKey();
    repo.insert(hash, {
      id,
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["read"],
      createdByUserId: "user-1",
      expiresAt: null,
      revokedAt: new Date(),
    });
    const result = await validateApiKey(repo, plain);
    expect(result).toBeNull();
  });

  it("returns null for an expired key", async () => {
    const repo = createMockRepository();
    const { plain, hash, id } = generateApiKey();
    repo.insert(hash, {
      id,
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["read"],
      createdByUserId: "user-1",
      expiresAt: new Date(Date.now() - 86_400_000),
      revokedAt: null,
    });
    const result = await validateApiKey(repo, plain);
    expect(result).toBeNull();
  });

  // B3: An API key with null createdByUserId must fail closed.
  it("returns null when createdByUserId is null", async () => {
    const repo = createMockRepository();
    const { plain, hash, id } = generateApiKey();
    repo.insert(hash, {
      id,
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["read"],
      createdByUserId: null,
      expiresAt: null,
      revokedAt: null,
    });
    const result = await validateApiKey(repo, plain);
    expect(result).toBeNull();
  });
});
