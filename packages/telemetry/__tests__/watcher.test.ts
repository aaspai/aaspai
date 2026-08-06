import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readIncrementalLines } from "../src/importers/incremental.js";
import { createTelemetryTestContext, TEST_ORGANIZATION } from "../src/test-utils.js";
import { TelemetryWatcher } from "../src/watcher.js";

const contexts: Awaited<ReturnType<typeof createTelemetryTestContext>>[] = [];
const dirs: string[] = [];

async function setup() {
  const context = await createTelemetryTestContext();
  contexts.push(context);
  const dir = mkdtempSync(join(tmpdir(), "aaspai-watch-"));
  dirs.push(dir);
  return { ...context, dir };
}

afterEach(async () => {
  while (contexts.length) {
    const c = contexts.pop();
    if (c) await c.cleanup();
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const LINE1 =
  '{"type":"user","timestamp":"2026-08-01T10:00:00Z","sessionId":"sess_watch","message":{"id":"m1","role":"user","content":[{"type":"text","text":"first"}]}}';
const LINE2 =
  '{"type":"assistant","timestamp":"2026-08-01T10:00:05Z","sessionId":"sess_watch","requestId":"r1","message":{"id":"m2","model":"claude-sonnet-4-5","role":"assistant","content":[{"type":"text","text":"second"}],"usage":{"input_tokens":10,"output_tokens":5}}}';

describe("incremental line reader (byte-offset)", () => {
  it("imports only new content on append (T142) and resumes from cursor (T147)", async () => {
    const { dir } = await setup();
    const file = join(dir, "sess_watch.jsonl");
    writeFileSync(file, `${LINE1}\n`, "utf8");

    const state1 = { byteOffset: 0, messageCount: 0, parserState: {} };
    const r1 = await readIncrementalLines(file, state1, () => true);
    expect(r1.recordCount).toBe(1);
    expect(r1.state.byteOffset).toBe(LINE1.length + 1);

    appendFileSync(file, `${LINE2}\n`, "utf8");
    const r2 = await readIncrementalLines(file, r1.state, () => true);
    expect(r2.recordCount).toBe(1);
    expect(r2.state.byteOffset).toBe(r1.state.byteOffset + LINE2.length + 1);

    // Restart from persisted cursor: nothing new.
    const r3 = await readIncrementalLines(file, r2.state, () => true);
    expect(r3.recordCount).toBe(0);
  });

  it("does not commit a partial trailing line (resumable)", async () => {
    const { dir } = await setup();
    const file = join(dir, "sess_watch.jsonl");
    writeFileSync(file, `${LINE1}\n${LINE2.slice(0, 40)}`, "utf8"); // truncated second line
    const state = { byteOffset: 0, messageCount: 0, parserState: {} };
    // Handler mimics a JSON parser: only commit complete lines (has newline).
    const r = await readIncrementalLines(file, state, (_line, _lineNo, hasNewline) => hasNewline);
    expect(r.recordCount).toBe(1); // only the complete line
    expect(r.state.byteOffset).toBe(LINE1.length + 1); // partial not committed
  });

  it("restarts from the beginning after truncation", async () => {
    const { dir } = await setup();
    const file = join(dir, "sess_watch.jsonl");
    writeFileSync(file, `${LINE1}\n${LINE2}\n`, "utf8");
    const full = { byteOffset: LINE1.length + LINE2.length + 2, messageCount: 2, parserState: {} };
    writeFileSync(file, `${LINE1}\n`, "utf8"); // truncated
    const r = await readIncrementalLines(file, full, () => true);
    expect(r.recordCount).toBe(1);
  });
});

describe("TelemetryWatcher (T140, T141, T144, T146)", () => {
  it("startup scan without backfill records position without importing", async () => {
    const { repo, hub, dir } = await setup();
    const file = join(dir, "sess_watch.jsonl");
    writeFileSync(file, `${LINE1}\n`, "utf8");
    const watcher = new TelemetryWatcher(repo, hub, {
      organizationId: TEST_ORGANIZATION,
      sources: ["claude-code"],
      envPaths: { claude: dir },
      backfill: false,
    });
    await watcher.start();
    const state = repo.getImportState(TEST_ORGANIZATION, "claude-code", file);
    expect(state?.byteOffset).toBe(LINE1.length + 1);
    expect(repo.queryLogs({ organizationId: TEST_ORGANIZATION }).total).toBe(0);
    await watcher.stop();
  });

  it("startup scan with backfill imports existing files", async () => {
    const { repo, hub, dir } = await setup();
    const file = join(dir, "sess_watch.jsonl");
    writeFileSync(file, `${LINE1}\n${LINE2}\n`, "utf8");
    const watcher = new TelemetryWatcher(repo, hub, {
      organizationId: TEST_ORGANIZATION,
      sources: ["claude-code"],
      envPaths: { claude: dir },
      backfill: true,
    });
    await watcher.start();
    expect(repo.queryLogs({ organizationId: TEST_ORGANIZATION }).total).toBeGreaterThan(0);
    await watcher.stop();
  });

  it("append imports only new content and re-processing is idempotent (T144)", async () => {
    const { repo, hub, dir } = await setup();
    const file = join(dir, "sess_watch.jsonl");
    writeFileSync(file, `${LINE1}\n`, "utf8");
    const watcher = new TelemetryWatcher(repo, hub, {
      organizationId: TEST_ORGANIZATION,
      sources: ["claude-code"],
      envPaths: { claude: dir },
      backfill: true,
    });
    await watcher.start();
    const afterFirst = repo.queryLogs({ organizationId: TEST_ORGANIZATION }).total ?? 0;
    expect(afterFirst).toBeGreaterThan(0);

    appendFileSync(file, `${LINE2}\n`, "utf8");
    const watcherInternal = watcher as unknown as {
      processFile(tw: { source: string }, filePath: string): Promise<void>;
      toolWatchers: Array<{ source: string }>;
    };
    await watcherInternal.processFile(watcherInternal.toolWatchers[0]!, file);
    const afterSecond = repo.queryLogs({ organizationId: TEST_ORGANIZATION }).total ?? 0;
    expect(afterSecond).toBeGreaterThan(afterFirst);

    // Re-processing the same file must not duplicate (dedup keys).
    await watcherInternal.processFile(watcherInternal.toolWatchers[0]!, file);
    expect(repo.queryLogs({ organizationId: TEST_ORGANIZATION }).total).toBe(afterSecond);
    await watcher.stop();
  });

  it("a malformed file does not stop other files from importing (T146)", async () => {
    const { repo, hub, dir } = await setup();
    const good = join(dir, "sess_good.jsonl");
    const bad = join(dir, "sess_bad.jsonl");
    writeFileSync(good, `${LINE1}\n`, "utf8");
    writeFileSync(bad, "{this is not json\n", "utf8");
    const watcher = new TelemetryWatcher(repo, hub, {
      organizationId: TEST_ORGANIZATION,
      sources: ["claude-code"],
      envPaths: { claude: dir },
      backfill: true,
    });
    await watcher.start();
    expect(repo.queryLogs({ organizationId: TEST_ORGANIZATION }).total).toBeGreaterThan(0);
    await watcher.stop();
  });

  it("rejects files outside the configured root (T149)", async () => {
    const { repo, hub, dir } = await setup();
    const outside = join(dir, "..", "outside-sess.jsonl");
    writeFileSync(outside, `${LINE1}\n`, "utf8");
    const watcher = new TelemetryWatcher(repo, hub, {
      organizationId: TEST_ORGANIZATION,
      sources: ["claude-code"],
      envPaths: { claude: dir },
      backfill: true,
    });
    await watcher.start();
    // The watcher only scanned the configured dir; the outside file is never imported.
    expect(
      repo.queryLogs({ organizationId: TEST_ORGANIZATION, sessionId: "sess_watch" }).total,
    ).toBe(0);
    await watcher.stop();
  });

  it("exposes health with last scan time (T152)", async () => {
    const { repo, hub, dir } = await setup();
    const file = join(dir, "sess_watch.jsonl");
    writeFileSync(file, `${LINE1}\n`, "utf8");
    const watcher = new TelemetryWatcher(repo, hub, {
      organizationId: TEST_ORGANIZATION,
      sources: ["claude-code"],
      envPaths: { claude: dir },
      backfill: false,
    });
    await watcher.start();
    const health = watcher.healthSnapshot();
    expect(health.lastScanAt).toBeDefined();
    expect(health.watchedFiles).toBeGreaterThan(0);
    await watcher.stop();
  });
});
