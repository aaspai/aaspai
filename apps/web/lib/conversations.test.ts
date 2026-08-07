import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDefaultDb, createDb, type DbHandle, eq, runMigrations, schema } from "@aaspai/db";
import {
  findConversationRoot,
  getConversationDetail,
  listConversations,
} from "@/lib/conversations";

const ORG = "org_conv";
const tempDirs: string[] = [];

function makeDb(label: string): DbHandle {
  const dir = mkdtempSync(join(tmpdir(), `aaspai-conv-${label}-`));
  tempDirs.push(dir);
  process.env.AASPAI_DB = `sqlite:${join(dir, "state.db")}`;
  const handle = createDb();
  runMigrations(handle);
  return handle;
}

test.after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the handle; best-effort cleanup */
    }
  }
});

async function closeDb(handle: DbHandle) {
  await handle.close().catch(() => undefined);
  // conversations.ts reads through the cached default handle; reset it so
  // the next test opens its own temp database.
  await closeDefaultDb().catch(() => undefined);
}

interface SessionSeed {
  id: string;
  agentId: string;
  prompt: string;
  status?: string;
  wakeupId?: string;
  parentSessionId?: string;
  sessionId?: string;
  sessionParamsJson?: string;
  startedAt: string;
  finishedAt?: string;
}

async function seedSession(handle: DbHandle, s: SessionSeed) {
  await handle.db.insert(schema.sessions).values({
    id: s.id,
    organizationId: ORG,
    wakeupId: s.wakeupId ?? "manual",
    agentId: s.agentId,
    adapter: "aaspai",
    runtimeJson: "{}",
    prompt: s.prompt,
    configJson: "{}",
    status: s.status ?? "succeeded",
    sessionId: s.sessionId ?? null,
    sessionParamsJson: s.sessionParamsJson ?? null,
    parentSessionId: s.parentSessionId ?? null,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt ?? null,
  });
}

async function seedEvent(
  handle: DbHandle,
  sessionId: string,
  seq: number,
  kind: string,
  payload: Record<string, unknown>,
) {
  await handle.db.insert(schema.sessionEvents).values({
    sessionId,
    ts: new Date().toISOString(),
    kind,
    payloadJson: JSON.stringify(payload),
    seq,
  });
}

test("conversations: listConversations groups chained chat sessions into one thread", async () => {
  const handle = makeDb("list");
  try {
    // Turn 1 (root)
    await seedSession(handle, {
      id: "sess_root1",
      agentId: "agent/ceo",
      prompt: "Hire a marketing manager who writes tweets",
      wakeupId: "chat_abc",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      sessionId: "rt-1",
    });
    // Turn 2 (child of root1)
    await seedSession(handle, {
      id: "sess_child1",
      agentId: "agent/ceo",
      prompt: "Make the posting shorter",
      wakeupId: "chat_def",
      parentSessionId: "sess_root1",
      startedAt: "2026-01-01T00:02:00.000Z",
      finishedAt: "2026-01-01T00:03:00.000Z",
      sessionId: "rt-2",
    });
    // Unrelated single chat session
    await seedSession(handle, {
      id: "sess_other",
      agentId: "agent/developer",
      prompt: "Fix the login bug",
      wakeupId: "chat_xyz",
      startedAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:01:00.000Z",
      sessionId: "rt-3",
    });

    const conversations = await listConversations(ORG, 50);
    assert.equal(conversations.length, 2);

    // Newest first: sess_other (Jan 2) then root1 (Jan 1)
    assert.equal(conversations[0]?.id, "sess_other");
    assert.equal(conversations[1]?.id, "sess_root1");

    const thread = conversations[1]!;
    assert.equal(thread.agentId, "agent/ceo");
    assert.equal(thread.turnCount, 2);
    assert.equal(thread.title, "Hire a marketing manager who writes tweets");
    assert.equal(thread.status, "succeeded");
  } finally {
    await closeDb(handle);
  }
});

test("conversations: listConversations filters by agent", async () => {
  const handle = makeDb("filter");
  try {
    await seedSession(handle, {
      id: "sess_ceo",
      agentId: "agent/ceo",
      prompt: "Hello",
      wakeupId: "chat_a",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedSession(handle, {
      id: "sess_dev",
      agentId: "agent/developer",
      prompt: "Hi dev",
      wakeupId: "chat_b",
      startedAt: "2026-01-02T00:00:00.000Z",
    });

    const ceo = await listConversations(ORG, 50, "agent/ceo");
    assert.equal(ceo.length, 1);
    assert.equal(ceo[0]?.id, "sess_ceo");
  } finally {
    await closeDb(handle);
  }
});

test("conversations: getConversationDetail rebuilds UIMessages and resume payload", async () => {
  const handle = makeDb("detail");
  try {
    await seedSession(handle, {
      id: "sess_root",
      agentId: "agent/ceo",
      prompt: "First turn",
      wakeupId: "chat_1",
      startedAt: "2026-01-01T00:00:00.000Z",
      sessionId: "rt-session-1",
      sessionParamsJson: JSON.stringify({ threadId: "t1" }),
    });
    await seedEvent(handle, "sess_root", 1, "assistant", { text: "Hello back" });
    await seedEvent(handle, "sess_root", 2, "thinking", { text: "considering…" });

    await seedSession(handle, {
      id: "sess_child",
      agentId: "agent/ceo",
      prompt: "Second turn",
      wakeupId: "chat_2",
      parentSessionId: "sess_root",
      startedAt: "2026-01-01T00:01:00.000Z",
      sessionId: "rt-session-2",
      sessionParamsJson: JSON.stringify({ threadId: "t1" }),
    });
    await seedEvent(handle, "sess_child", 1, "tool_call", {
      name: "bash",
      id: "call-1",
      input: { command: "ls" },
    });
    await seedEvent(handle, "sess_child", 2, "tool_result", {
      name: "bash",
      id: "call-1",
      output: "README.md",
    });
    await seedEvent(handle, "sess_child", 3, "assistant", { text: "Second reply" });

    const detail = await getConversationDetail(ORG, "sess_root");
    assert.ok(detail);
    assert.equal(detail.turnCount, 2);
    assert.equal(detail.agentId, "agent/ceo");

    // 4 messages: user, assistant, user, assistant
    assert.equal(detail.messages.length, 4);
    assert.equal(detail.messages[0]!.role, "user");
    assert.equal((detail.messages[0]!.parts[0] as { text: string }).text, "First turn");
    assert.equal(detail.messages[1]!.role, "assistant");
    assert.equal(detail.messages[3]!.role, "assistant");

    // Resume should point at the last (child) turn's runtime session.
    assert.equal(detail.resume.parentSessionId, "sess_child");
    assert.equal(detail.resume.resumeSessionId, "rt-session-2");
    assert.deepEqual(detail.resume.resumeSessionParams, { threadId: "t1" });

    // Non-chat (worker/loop) sessions must not be surfaced as conversations.
    const root2 = await getConversationDetail(ORG, "sess_root");
    assert.ok(root2);
  } finally {
    await closeDb(handle);
  }
});

test("conversations: non-chat sessions are excluded and org is scoped", async () => {
  const handle = makeDb("scope");
  try {
    // Loop/worker session with a manual wakeup id — not an inbox thread.
    await seedSession(handle, {
      id: "sess_loop",
      agentId: "agent/ceo",
      prompt: "Loop run",
      wakeupId: "manual",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const list = await listConversations(ORG, 50);
    assert.equal(list.length, 0);
    assert.equal(await getConversationDetail(ORG, "sess_loop"), null);

    // Detail for a session in another org is denied.
    await seedSession(handle, {
      id: "sess_other_org",
      agentId: "agent/ceo",
      prompt: "Other org",
      wakeupId: "chat_zz",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    // Swap the org on the row directly to simulate cross-org ownership.
    await handle.db
      .update(schema.sessions)
      .set({ organizationId: "org_other" })
      .where(eq(schema.sessions.id, "sess_other_org"));
    assert.equal(await getConversationDetail(ORG, "sess_other_org"), null);
  } finally {
    await closeDb(handle);
  }
});

test("conversations: findConversationRoot walks to the thread root", async () => {
  const handle = makeDb("root");
  try {
    await seedSession(handle, {
      id: "sess_a",
      agentId: "agent/ceo",
      prompt: "A",
      wakeupId: "chat_a",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedSession(handle, {
      id: "sess_b",
      agentId: "agent/ceo",
      prompt: "B",
      wakeupId: "chat_b",
      parentSessionId: "sess_a",
      startedAt: "2026-01-01T00:01:00.000Z",
    });
    await seedSession(handle, {
      id: "sess_c",
      agentId: "agent/ceo",
      prompt: "C",
      wakeupId: "chat_c",
      parentSessionId: "sess_b",
      startedAt: "2026-01-01T00:02:00.000Z",
    });

    assert.equal(await findConversationRoot(ORG, "sess_c"), "sess_a");
    assert.equal(await findConversationRoot(ORG, "sess_a"), "sess_a");
    assert.equal(await findConversationRoot(ORG, "sess_missing"), null);
  } finally {
    await closeDb(handle);
  }
});
