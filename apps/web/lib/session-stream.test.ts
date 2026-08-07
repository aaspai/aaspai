import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDb, type DbHandle, runMigrations, schema } from "@aaspai/db";
import { eq } from "drizzle-orm";
import { createSessionStreamHandler } from "../app/api/sessions/[id]/stream/route";

const USER = { id: "user_test", organizationId: "org_test" };

const tempDirs: string[] = [];

function makeDb(label: string): DbHandle {
  const dir = mkdtempSync(join(tmpdir(), `aaspai-stream-${label}-`));
  tempDirs.push(dir);
  process.env.AASPAI_DB = `sqlite:${join(dir, "state.db")}`;
  const handle = createDb();
  runMigrations(handle);
  return handle;
}

function readStream(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    const timeout = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new Error("stream did not close in time"));
    }, 3_000);
    const pump = () => {
      void reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            clearTimeout(timeout);
            resolve(out);
            return;
          }
          if (value) out += decoder.decode(value, { stream: true });
          pump();
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    };
    pump();
  });
}

test("T4: stream returns persisted events ordered by seq and honors Last-Event-ID", async () => {
  const handle = makeDb("resume");
  try {
    await handle.db.insert(schema.sessions).values({
      id: "sess_stream_t4",
      organizationId: "org_test",
      wakeupId: "manual",
      agentId: "agent/test",
      adapter: "dry_run_local",
      runtimeJson: "{}",
      prompt: "hi",
      configJson: "{}",
      status: "succeeded",
      finishedAt: "2026-01-01T00:00:03Z",
    });
    await handle.db.insert(schema.sessionEvents).values([
      {
        sessionId: "sess_stream_t4",
        ts: "2026-01-01T00:00:00Z",
        kind: "init",
        payloadJson: "{}",
        seq: 1,
      },
      {
        sessionId: "sess_stream_t4",
        ts: "2026-01-01T00:00:01Z",
        kind: "assistant",
        payloadJson: '{"text":"one"}',
        seq: 2,
      },
      {
        sessionId: "sess_stream_t4",
        ts: "2026-01-01T00:00:02Z",
        kind: "result",
        payloadJson: '{"summary":"two"}',
        seq: 3,
      },
    ]);

    const handler = createSessionStreamHandler({
      getDb: () => handle,
      getUser: async () => USER,
      ensureWorkspace: () => {},
      pollMs: 20,
    });
    const request = new Request("http://local/api", {
      headers: { "last-event-id": "2" },
    });
    const response = await handler(request, Promise.resolve({ id: "sess_stream_t4" }));
    assert.equal(response.status, 200);
    const body = await readStream(response.body!);

    // Only events after seq 2 (i.e. seq 3) should arrive.
    assert.match(body, /"seq":3/);
    assert.doesNotMatch(body, /"seq":1/);
    assert.doesNotMatch(body, /"seq":2/);
  } finally {
    await handle.close();
  }
});

test("T5: stream closes on terminal session status", async () => {
  const handle = makeDb("terminal");
  try {
    await handle.db.insert(schema.sessions).values({
      id: "sess_stream_t5",
      organizationId: "org_test",
      wakeupId: "manual",
      agentId: "agent/test",
      adapter: "dry_run_local",
      runtimeJson: "{}",
      prompt: "hi",
      configJson: "{}",
      status: "succeeded",
      finishedAt: "2026-01-01T00:00:01Z",
    });
    await handle.db.insert(schema.sessionEvents).values([
      {
        sessionId: "sess_stream_t5",
        ts: "2026-01-01T00:00:00Z",
        kind: "assistant",
        payloadJson: '{"text":"done"}',
        seq: 1,
      },
    ]);

    const handler = createSessionStreamHandler({
      getDb: () => handle,
      getUser: async () => USER,
      ensureWorkspace: () => {},
      pollMs: 20,
    });
    const response = await handler(
      new Request("http://local/api"),
      Promise.resolve({ id: "sess_stream_t5" }),
    );
    const body = await readStream(response.body!);
    // The terminal session still streams its events, then the stream
    // closes (readStream resolves instead of timing out).
    assert.match(body, /event: event/);
    assert.match(body, /"seq":1/);
    assert.match(body, /"text":"done"/);
  } finally {
    await handle.close();
  }
});

test("stream requires auth", async () => {
  const handle = makeDb("auth");
  try {
    const handler = createSessionStreamHandler({
      getDb: () => handle,
      getUser: async () => null,
      ensureWorkspace: () => {},
      pollMs: 20,
    });
    const response = await handler(
      new Request("http://local/api"),
      Promise.resolve({ id: "sess_x" }),
    );
    assert.equal(response.status, 401);
  } finally {
    await handle.close();
  }
});

test("stream 404s for unknown session", async () => {
  const handle = makeDb("missing");
  try {
    const handler = createSessionStreamHandler({
      getDb: () => handle,
      getUser: async () => USER,
      ensureWorkspace: () => {},
      pollMs: 20,
    });
    const response = await handler(
      new Request("http://local/api"),
      Promise.resolve({ id: "sess_missing" }),
    );
    assert.equal(response.status, 404);
  } finally {
    await handle.close();
  }
});

test("stream denies sessions from another organization", async () => {
  const handle = makeDb("orgdeny");
  try {
    await handle.db.insert(schema.sessions).values({
      id: "sess_stream_org",
      organizationId: "org_other",
      wakeupId: "manual",
      agentId: "agent/test",
      adapter: "dry_run_local",
      runtimeJson: "{}",
      prompt: "hi",
      configJson: "{}",
      status: "running",
    });
    const handler = createSessionStreamHandler({
      getDb: () => handle,
      getUser: async () => USER,
      ensureWorkspace: () => {},
      pollMs: 20,
    });
    const response = await handler(
      new Request("http://local/api"),
      Promise.resolve({ id: "sess_stream_org" }),
    );
    assert.equal(response.status, 403);
    await handle.db.delete(schema.sessions).where(eq(schema.sessions.id, "sess_stream_org"));
  } finally {
    await handle.close();
  }
});

test.after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});
