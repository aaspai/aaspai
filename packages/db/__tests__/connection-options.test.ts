import { describe, expect, it } from "vitest";
import { getDatabaseConnectionOptions } from "../src/connection-options";

describe("getDatabaseConnectionOptions", () => {
  it("uses production-safe defaults", () => {
    expect(getDatabaseConnectionOptions({ NODE_ENV: "production" })).toEqual({
      max: 10,
      connect_timeout: 10,
      idle_timeout: 30,
      max_lifetime: 1800,
    });
  });

  it("serializes tests onto a single persistent connection", () => {
    expect(getDatabaseConnectionOptions({ NODE_ENV: "test" })).toEqual({
      max: 1,
      connect_timeout: 10,
      idle_timeout: 0,
      max_lifetime: 1800,
    });
  });

  it("accepts bounded overrides and rejects unsafe values", () => {
    expect(
      getDatabaseConnectionOptions({
        AASPAI_DB_POOL_MAX: "24",
        AASPAI_DB_CONNECT_TIMEOUT_SECONDS: "15",
        AASPAI_DB_IDLE_TIMEOUT_SECONDS: "120",
        AASPAI_DB_MAX_LIFETIME_SECONDS: "3600",
      }),
    ).toEqual({
      max: 24,
      connect_timeout: 15,
      idle_timeout: 120,
      max_lifetime: 3600,
    });

    expect(
      getDatabaseConnectionOptions({
        AASPAI_DB_POOL_MAX: "1000",
        AASPAI_DB_CONNECT_TIMEOUT_SECONDS: "0",
        AASPAI_DB_IDLE_TIMEOUT_SECONDS: "-1",
        AASPAI_DB_MAX_LIFETIME_SECONDS: "nope",
      }),
    ).toEqual({
      max: 10,
      connect_timeout: 10,
      idle_timeout: 30,
      max_lifetime: 1800,
    });
  });
});
