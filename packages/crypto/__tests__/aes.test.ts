import { describe, expect, it } from "vitest";
import { decrypt, deriveKeyForTest, encrypt } from "../src/aes";

const KEY = deriveKeyForTest("test-secret");

describe("crypto/aes", () => {
  describe("encrypt -> decrypt roundtrip", () => {
    it("recovers the original plaintext", () => {
      const plaintext =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
      const envelope = encrypt(plaintext, KEY);
      expect(decrypt(envelope, KEY)).toBe(plaintext);
    });

    it("handles short strings", () => {
      const envelope = encrypt("hi", KEY);
      expect(decrypt(envelope, KEY)).toBe("hi");
    });

    it("handles empty string", () => {
      const envelope = encrypt("", KEY);
      expect(decrypt(envelope, KEY)).toBe("");
    });

    it("handles unicode", () => {
      const plaintext = "🔐 résumé naïve 中文 𝓤𝓽𝓯-8";
      const envelope = encrypt(plaintext, KEY);
      expect(decrypt(envelope, KEY)).toBe(plaintext);
    });

    it("handles very long strings (1 MB)", () => {
      const plaintext = "a".repeat(1024 * 1024);
      const envelope = encrypt(plaintext, KEY);
      expect(decrypt(envelope, KEY)).toBe(plaintext);
    });
  });

  describe("envelope format", () => {
    it("produces three base64 segments separated by colons", () => {
      const envelope = encrypt("test", KEY);
      const parts = envelope.split(":");
      expect(parts).toHaveLength(3);
      for (const part of parts) {
        expect(part).toMatch(/^[A-Za-z0-9+/]+=*$/);
      }
    });

    it("uses a fresh random IV on each call (different ciphertexts)", () => {
      const a = encrypt("same plaintext", KEY);
      const b = encrypt("same plaintext", KEY);
      expect(a).not.toBe(b);
    });
  });

  describe("key validation", () => {
    it("rejects keys of wrong length", () => {
      const shortKey = Buffer.alloc(16);
      expect(() => encrypt("test", shortKey)).toThrow(/32 bytes/);
      expect(() => decrypt("a:b:c", shortKey)).toThrow(/32 bytes/);
    });
  });

  describe("tamper detection (GCM auth tag)", () => {
    it("throws when ciphertext is modified", () => {
      const envelope = encrypt("hello world", KEY);
      const [iv, ct, tag] = envelope.split(":") as [string, string, string];
      const tamperedCt = `${ct.slice(0, 4)}X${ct.slice(5)}`;
      const tampered = `${iv}:${tamperedCt}:${tag}`;
      expect(() => decrypt(tampered, KEY)).toThrow();
    });

    it("throws when tag is modified", () => {
      const envelope = encrypt("hello world", KEY);
      const [iv, ct, tag] = envelope.split(":") as [string, string, string];
      const tamperedTag = `${tag.slice(0, 4)}X${tag.slice(5)}`;
      const tampered = `${iv}:${ct}:${tamperedTag}`;
      expect(() => decrypt(tampered, KEY)).toThrow();
    });

    it("throws when the wrong key is used", () => {
      const envelope = encrypt("secret", KEY);
      const otherKey = deriveKeyForTest("different-secret");
      expect(() => decrypt(envelope, otherKey)).toThrow();
    });
  });

  describe("malformed input", () => {
    it("rejects an envelope with the wrong number of parts", () => {
      expect(() => decrypt("only-one-part", KEY)).toThrow(/Malformed/);
      expect(() => decrypt("a:b", KEY)).toThrow(/Malformed/);
      expect(() => decrypt("a:b:c:d", KEY)).toThrow(/Malformed/);
    });

    it("rejects an IV of the wrong length", () => {
      const shortIv = Buffer.alloc(1).toString("base64");
      const envelope = `${shortIv}:AAAA:AAAA`;
      expect(() => decrypt(envelope, KEY)).toThrow(/IV length/);
    });

    it("rejects a tag of the wrong length", () => {
      const iv = Buffer.alloc(12).toString("base64");
      const shortTag = Buffer.alloc(1).toString("base64");
      const envelope = `${iv}:AAAA:${shortTag}`;
      expect(() => decrypt(envelope, KEY)).toThrow(/tag length/);
    });
  });

  describe("key ring (AASPAI_ENCRYPTION_KEYS)", () => {
    it("decrypts with the current key when the ring has one entry", () => {
      const savedKeys = process.env.AASPAI_ENCRYPTION_KEYS;
      const savedSingle = process.env.AASPAI_ENCRYPTION_KEY;
      const savedFallback = process.env.BETTER_AUTH_SECRET;
      process.env.AASPAI_ENCRYPTION_KEYS = "ring-key-1";
      delete process.env.AASPAI_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      const envelope = encrypt("hello");
      expect(decrypt(envelope)).toBe("hello");
      if (savedKeys !== undefined) process.env.AASPAI_ENCRYPTION_KEYS = savedKeys;
      if (savedSingle !== undefined) process.env.AASPAI_ENCRYPTION_KEY = savedSingle;
      if (savedFallback !== undefined) process.env.BETTER_AUTH_SECRET = savedFallback;
    });

    it("decrypts ciphertexts from an old key after rotation (forward compat)", () => {
      const savedKeys = process.env.AASPAI_ENCRYPTION_KEYS;
      const savedSingle = process.env.AASPAI_ENCRYPTION_KEY;
      const savedFallback = process.env.BETTER_AUTH_SECRET;
      try {
        process.env.AASPAI_ENCRYPTION_KEYS = "key-A";
        delete process.env.AASPAI_ENCRYPTION_KEY;
        delete process.env.BETTER_AUTH_SECRET;
        const oldEnvelope = encrypt("old secret");

        process.env.AASPAI_ENCRYPTION_KEYS = "key-B,key-A";
        expect(decrypt(oldEnvelope)).toBe("old secret");

        const newEnvelope = encrypt("new secret");
        process.env.AASPAI_ENCRYPTION_KEYS = "key-B";
        expect(decrypt(newEnvelope)).toBe("new secret");
        expect(() => decrypt(oldEnvelope)).toThrow(/No key in the encryption key ring/);
      } finally {
        if (savedKeys !== undefined) process.env.AASPAI_ENCRYPTION_KEYS = savedKeys;
        if (savedSingle !== undefined) process.env.AASPAI_ENCRYPTION_KEY = savedSingle;
        if (savedFallback !== undefined) process.env.BETTER_AUTH_SECRET = savedFallback;
      }
    });

    it("refuses to fall back to BETTER_AUTH_SECRET in production", () => {
      const savedKeys = process.env.AASPAI_ENCRYPTION_KEYS;
      const savedSingle = process.env.AASPAI_ENCRYPTION_KEY;
      const savedFallback = process.env.BETTER_AUTH_SECRET;
      const savedEnv = process.env.NODE_ENV;
      try {
        delete process.env.AASPAI_ENCRYPTION_KEYS;
        delete process.env.AASPAI_ENCRYPTION_KEY;
        process.env.BETTER_AUTH_SECRET = "some-secret";
        process.env.NODE_ENV = "production";
        expect(() => encrypt("x")).toThrow(/AASPAI_ENCRYPTION_KEYS/);
      } finally {
        if (savedKeys !== undefined) process.env.AASPAI_ENCRYPTION_KEYS = savedKeys;
        if (savedSingle !== undefined) process.env.AASPAI_ENCRYPTION_KEY = savedSingle;
        if (savedFallback !== undefined) process.env.BETTER_AUTH_SECRET = savedFallback;
        if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
        else delete process.env.NODE_ENV;
      }
    });

    it("throws when no keys are available in production", () => {
      const savedKeys = process.env.AASPAI_ENCRYPTION_KEYS;
      const savedSingle = process.env.AASPAI_ENCRYPTION_KEY;
      const savedFallback = process.env.BETTER_AUTH_SECRET;
      const savedEnv = process.env.NODE_ENV;
      try {
        delete process.env.AASPAI_ENCRYPTION_KEYS;
        delete process.env.AASPAI_ENCRYPTION_KEY;
        delete process.env.BETTER_AUTH_SECRET;
        process.env.NODE_ENV = "production";
        expect(() => encrypt("x")).toThrow();
      } finally {
        if (savedKeys !== undefined) process.env.AASPAI_ENCRYPTION_KEYS = savedKeys;
        if (savedSingle !== undefined) process.env.AASPAI_ENCRYPTION_KEY = savedSingle;
        if (savedFallback !== undefined) process.env.BETTER_AUTH_SECRET = savedFallback;
        if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
        else delete process.env.NODE_ENV;
      }
    });
  });
});
