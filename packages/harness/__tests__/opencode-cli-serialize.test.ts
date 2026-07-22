import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@aaspai/observability", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const spawn = vi.fn();
const execFile = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawn(...args),
  execFile: (...args: unknown[]) => execFile(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return {
    ...mod,
    existsSync: ((p: string) => {
      if (typeof p === "string" && p.includes("opencode") && !p.includes("aaspai-opencode"))
        return true;
      return mod.existsSync(p);
    }) as typeof mod.existsSync,
  };
});

interface ChildMock {
  pid?: number;
  stdout: {
    on: (e: string, h: (chunk: string) => void) => void;
    _data: string[];
    _emit: (c: string) => void;
  };
  stderr: {
    on: (e: string, h: (chunk: string) => void) => void;
    _data: string[];
    _emit: (c: string) => void;
  };
  stdin: { on: (e: string, h: () => void) => void; write: () => void; end: () => void };
  on: (e: string, h: (code: number) => void) => void;
  _emitClose: (code: number) => void;
  _emitError: (err: Error) => void;
  kill: (sig: string) => void;
  killed: boolean;
}

function makeChild(): ChildMock {
  const stdoutHandlers: ((c: string) => void)[] = [];
  const stderrHandlers: ((c: string) => void)[] = [];
  const stdinErrHandlers: (() => void)[] = [];
  const closeHandlers: ((c: number) => void)[] = [];
  const errorHandlers: ((err: Error) => void)[] = [];
  return {
    pid: Math.floor(Math.random() * 100_000),
    stdout: {
      on: (e: string, h: (chunk: string) => void) => {
        if (e === "data") stdoutHandlers.push(h);
      },
      _data: [],
      _emit: (c: string) =>
        stdoutHandlers.forEach((h) => {
          h(c);
        }),
    } as never,
    stderr: {
      on: (e: string, h: (chunk: string) => void) => {
        if (e === "data") stderrHandlers.push(h);
      },
      _data: [],
      _emit: (c: string) =>
        stderrHandlers.forEach((h) => {
          h(c);
        }),
    } as never,
    stdin: {
      on: (e: string, h: () => void) => {
        if (e === "error") stdinErrHandlers.push(h);
      },
      write: () => {},
      end: () => {},
    } as never,
    on: (e: string, h: ((code: number) => void) | ((err: Error) => void)) => {
      if (e === "close") closeHandlers.push(h as (c: number) => void);
      if (e === "error") errorHandlers.push(h as (err: Error) => void);
    },
    _emitClose: (code: number) =>
      closeHandlers.forEach((h) => {
        h(code);
      }),
    _emitError: (err: Error) =>
      errorHandlers.forEach((h) => {
        h(err);
      }),
    kill: () => {},
    killed: false,
  };
}

beforeEach(() => {
  // Set a unique lock path per test to avoid cross-test pollution
  process.env.AASPAI_OPENCODE_LOCK_PATH = join(
    realTmpdir(),
    `aaspai-test-lock-${Math.random().toString(36).slice(2)}-${Date.now()}.lock`,
  );
  spawn.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("opencode_cli per-process serialization", () => {
  it("never has more than one opencode child process alive at the same time", async () => {
    const { opencodeCli } = await import("../src/drivers/opencode-cli/index.js");

    // Track peak concurrent opencode children across the run.
    const childrenAlive: { count: number } = { count: 0 };
    const peakObserved = { value: 0 };

    spawn.mockImplementation(() => {
      childrenAlive.count++;
      peakObserved.value = Math.max(peakObserved.value, childrenAlive.count);
      const child = makeChild();
      // After a short delay, emit 'close' with code 0.
      setTimeout(() => {
        try {
          child._emitClose(0);
        } catch {
          /* child may already be torn down */
        }
        childrenAlive.count--;
      }, 30);
      return child as never;
    });

    const ctx = {
      context: { prompt: "do something" },
      config: { model: "opencode-go/mimo-v2.5" },
      onLog: async () => {},
    };

    const calls = [
      opencodeCli.execute(ctx as never),
      opencodeCli.execute(ctx as never),
      opencodeCli.execute(ctx as never),
    ];

    const results = await Promise.allSettled(calls);
    for (const r of results) {
      if (r.status === "rejected") {
        // eslint-disable-next-line no-console
        console.error("call rejected:", r.reason);
      }
    }

    // With serialization, peak concurrent children should be 1.
    // Without serialization, this would be 3.
    expect(peakObserved.value).toBeLessThanOrEqual(1);
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});

describe("opencode_cli cross-process lock", () => {
  beforeEach(() => {
    process.env.AASPAI_OPENCODE_LOCK_PATH = join(
      realTmpdir(),
      `aaspai-test-lock-${Math.random().toString(36).slice(2)}-${Date.now()}.lock`,
    );
  });

  it("acquires and releases the lock between calls", async () => {
    const fs = await import("node:fs");
    const lockPath = process.env.AASPAI_OPENCODE_LOCK_PATH!;

    // Lock should not exist initially
    expect(fs.existsSync(lockPath)).toBe(false);

    // Run one execute; it should acquire and release the lock
    spawn.mockImplementation(() => {
      const child = makeChild();
      setTimeout(() => {
        try {
          child._emitClose(0);
        } catch {
          /* */
        }
      }, 10);
      return child as never;
    });

    const { opencodeCli } = await import("../src/drivers/opencode-cli/index.js");
    const ctx = {
      context: { prompt: "hi" },
      config: { model: "opencode-go/mimo-v2.5" },
      onLog: async () => {},
    };
    await opencodeCli.execute(ctx as never);

    // Lock should be released after execute returns
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
