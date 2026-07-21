import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, rootLogger, setMinLevel } from "../src/logger";

describe("Logger", () => {
  beforeEach(() => {
    setMinLevel("trace");
  });

  it("creates a module-scoped logger", () => {
    const log = getLogger("test-module");
    log.info("hello");
    // no throw = success
  });

  it("creates child loggers with bound context", () => {
    const log = getLogger("parent");
    const child = log.child({ component: "child" });
    child.info("from child");
    // no throw = success
  });

  it("supports all log levels without throwing", () => {
    const log = getLogger("levels");
    log.trace("trace msg");
    log.debug("debug msg");
    log.info("info msg");
    log.warn("warn msg");
    log.error("error msg");
    log.fatal("fatal msg");
    // no throw = success
  });

  it("rootLogger writes to stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write");
    rootLogger.info("root test");
    expect(writeSpy).toHaveBeenCalled();
    const call = writeSpy.mock.calls[0]?.[0] as string;
    expect(call).toContain("root test");
    expect(call).toContain('"level":"info"');
    writeSpy.mockRestore();
  });

  it("error level writes to stderr", () => {
    const writeSpy = vi.spyOn(process.stderr, "write");
    rootLogger.error("error test");
    expect(writeSpy).toHaveBeenCalled();
    const call = writeSpy.mock.calls[0]?.[0] as string;
    expect(call).toContain("error test");
    expect(call).toContain('"level":"error"');
    writeSpy.mockRestore();
  });

  it("setMinLevel filters lower levels", () => {
    setMinLevel("warn");
    rootLogger.info("should be filtered");
    rootLogger.warn("should appear");

    // Verify by checking env — info level rank (30) < warn (40) = filtered
    const log = getLogger("filter-check");
    let captured = "";
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        captured += String(chunk);
        return true;
      });
    log.info("after-filter");
    expect(captured).toBe(""); // info should not reach stdout at warn level
    spy.mockRestore();
  });
});
