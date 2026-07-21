/**
 * M1.C10: assertTestDatabaseUrl guard tests (T35.2).
 *
 * The guard is a defense against accidentally running tests
 * against a production database. It rejects:
 *   - missing DATABASE_URL
 *   - non-postgres protocols
 *   - database names without "test" in them (unless the
 *     AASPAI_ALLOW_TEST_TRUNCATE=1 opt-out is set)
 *
 * Each branch is asserted here so a future refactor can't
 * silently weaken the guard.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertTestDatabaseUrl, testDatabaseConnectTimeoutSeconds } from "../src/test-utils";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
const ORIGINAL_ALLOW = process.env.AASPAI_ALLOW_TEST_TRUNCATE;

beforeEach(() => {
  delete process.env.AASPAI_ALLOW_TEST_TRUNCATE;
});

afterEach(() => {
  if (ORIGINAL_DB_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DB_URL;
  }
  if (ORIGINAL_ALLOW === undefined) {
    delete process.env.AASPAI_ALLOW_TEST_TRUNCATE;
  } else {
    process.env.AASPAI_ALLOW_TEST_TRUNCATE = ORIGINAL_ALLOW;
  }
});

describe("assertTestDatabaseUrl (T35.2)", () => {
  it("throws when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL;
    expect(() => assertTestDatabaseUrl(undefined)).toThrow(/DATABASE_URL is not set/);
  });

  it("throws when DATABASE_URL is not a valid URL", () => {
    process.env.DATABASE_URL = "not-a-url";
    expect(() => assertTestDatabaseUrl()).toThrow(/not a valid URL/);
  });

  it("throws when DATABASE_URL is not postgres/postgresql", () => {
    process.env.DATABASE_URL = "mysql://user:pw@host:3306/test_db";
    expect(() => assertTestDatabaseUrl()).toThrow(/postgres\/postgresql/);
  });

  it("throws when the database name is empty", () => {
    process.env.DATABASE_URL = "postgres://user:pw@host:5432/";
    expect(() => assertTestDatabaseUrl()).toThrow(/no database name/);
  });

  it("rejects a production-looking database name", () => {
    process.env.DATABASE_URL = "postgres://user:pw@host:5432/production";
    expect(() => assertTestDatabaseUrl()).toThrow(/refusing destructive test cleanup/);
  });

  it("rejects a non-test database name", () => {
    process.env.DATABASE_URL = "postgres://user:pw@host:5432/application";
    expect(() => assertTestDatabaseUrl()).toThrow(/refusing destructive test cleanup/);
  });

  it("accepts a database name containing 'test'", () => {
    process.env.DATABASE_URL = "postgres://user:pw@host:5432/aaspai_test";
    const name = assertTestDatabaseUrl();
    expect(name).toBe("aaspai_test");
  });

  it("accepts a database name starting with 'test'", () => {
    process.env.DATABASE_URL = "postgres://user:pw@host:5432/test_db";
    const name = assertTestDatabaseUrl();
    expect(name).toBe("test_db");
  });

  it("accepts a database name with the 'test-' prefix", () => {
    process.env.DATABASE_URL = "postgres://user:pw@host:5432/test-aaspai";
    const name = assertTestDatabaseUrl();
    expect(name).toBe("test-aaspai");
  });

  it("AASPAI_ALLOW_TEST_TRUNCATE=1 bypasses the test-name check", () => {
    process.env.DATABASE_URL = "postgres://user:pw@host:5432/production";
    process.env.AASPAI_ALLOW_TEST_TRUNCATE = "1";
    const name = assertTestDatabaseUrl();
    expect(name).toBe("production");
  });

  it("respects a custom context label in the error", () => {
    delete process.env.DATABASE_URL;
    expect(() => assertTestDatabaseUrl(undefined, "my-test-helper")).toThrow(/my-test-helper/);
  });
});

describe("testDatabaseConnectTimeoutSeconds", () => {
  it("defaults invalid and missing values to five seconds", () => {
    expect(testDatabaseConnectTimeoutSeconds("")).toBe(5);
    expect(testDatabaseConnectTimeoutSeconds("0")).toBe(5);
    expect(testDatabaseConnectTimeoutSeconds("31")).toBe(5);
    expect(testDatabaseConnectTimeoutSeconds("not-a-number")).toBe(5);
  });

  it("accepts bounded integer values", () => {
    expect(testDatabaseConnectTimeoutSeconds("1")).toBe(1);
    expect(testDatabaseConnectTimeoutSeconds("10")).toBe(10);
    expect(testDatabaseConnectTimeoutSeconds("30")).toBe(30);
  });
});
