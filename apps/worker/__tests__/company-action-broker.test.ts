import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CompanyActionBroker,
  startCompanyActionBroker,
} from "../src/company-action-broker.js";

describe("attempt-scoped company action broker", () => {
  let broker: CompanyActionBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it("applies a hire in-session and returns its durable IDs", async () => {
    const apply = vi.fn(async (actions) => [
      {
        actionIndex: 0,
        actionType: actions[0]!.type,
        projectId: "project/growth",
        status: "succeeded" as const,
        outcome: {
          agentId: "agent/researcher",
          delegationId: "delegation/durable",
          delegatedWorkItemId: "work/durable",
        },
      },
    ]);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      apply,
    });

    const action = {
      type: "hire_and_delegate",
      agentId: "agent/researcher",
      title: "Researcher",
      role: "researcher",
      description: "Validates customer demand.",
      workTitle: "Validate demand",
      workDescription: "Produce cited evidence.",
      projectId: "project/growth",
    };
    const response = await request(broker, { actions: [action] });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      results: [
        {
          actionType: "hire_and_delegate",
          outcome: {
            delegationId: "delegation/durable",
            delegatedWorkItemId: "work/durable",
          },
        },
      ],
    });
    expect(apply).toHaveBeenCalledOnce();

    const duplicate = await request(
      broker,
      JSON.stringify(
        {
          actions: [
            {
              projectId: action.projectId,
              workDescription: action.workDescription,
              workTitle: action.workTitle,
              description: action.description,
              role: action.role,
              title: action.title,
              agentId: action.agentId,
              type: action.type,
            },
          ],
        },
        null,
        2,
      ),
    );
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      results: [{ outcome: { delegatedWorkItemId: "work/durable" } }],
    });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("rejects tokens and correlation fields from another attempt", async () => {
    const apply = vi.fn(async () => []);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      apply,
    });
    const payload = { actions: [milestone()] };

    expect((await request(broker, payload, { token: "wrong-token" })).status).toBe(401);
    expect((await request(broker, payload, { attemptId: "attempt/two" })).status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });

  it("binds resumed mutations to the OpenCode provider session", async () => {
    const apply = vi.fn(async () => []);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      requiredProviderSessionId: "session/original",
      apply,
    });

    expect((await request(broker, { actions: [milestone()] })).status).toBe(403);
    expect(
      (
        await request(
          broker,
          { actions: [milestone()] },
          {
            providerSessionId: "session/drifted",
          },
        )
      ).status,
    ).toBe(403);
    expect(apply).not.toHaveBeenCalled();

    expect(
      (
        await request(
          broker,
          { actions: [milestone()] },
          {
            providerSessionId: "session/original",
          },
        )
      ).status,
    ).toBe(200);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("rejects the attempt token in company fields without reflecting it", async () => {
    const apply = vi.fn(async () => []);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      apply,
    });
    const token = broker.env.AASPAI_COMPANY_BROKER_TOKEN!;
    const response = await request(broker, {
      actions: [{ ...milestone(), acceptance: { proof: `bearer ${token}` } }],
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("company_action_contains_ephemeral_secret");
    expect(body).not.toContain(token);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects oversized input before applying it", async () => {
    const apply = vi.fn(async () => []);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      apply,
    });
    const response = await request(broker, "x".repeat(65_537));

    expect(response.status).toBe(413);
    expect(apply).not.toHaveBeenCalled();
  });

  it("requires atomic single-action requests", async () => {
    const apply = vi.fn(async () => []);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      apply,
    });

    const response = await request(broker, { actions: [milestone(), milestone()] });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      message: "company_action_requires_single_action",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("caps unique company mutations per attempt while replaying duplicates", async () => {
    const apply = vi.fn(async () => []);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      apply,
    });

    for (let sequence = 0; sequence < 32; sequence++) {
      const response = await request(broker, {
        actions: [{ ...milestone(), sequence, title: `Milestone ${sequence}` }],
      });
      expect(response.status).toBe(200);
    }
    expect(
      (
        await request(broker, {
          actions: [{ ...milestone(), sequence: 32, title: "Milestone 32" }],
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await request(broker, {
          actions: [{ ...milestone(), sequence: 0, title: "Milestone 0" }],
        })
      ).status,
    ).toBe(200);
    expect(apply).toHaveBeenCalledTimes(32);
  });

  it("deduplicates projected actions when untrusted input adds unknown fields", async () => {
    const apply = vi.fn(async () => []);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      apply,
    });

    expect(
      (await request(broker, { actions: [{ ...milestone(), ignoredNonce: "first" }] })).status,
    ).toBe(200);
    expect(
      (await request(broker, { actions: [{ ...milestone(), ignoredNonce: "second" }] })).status,
    ).toBe(200);

    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0]?.[0]).not.toHaveProperty("ignoredNonce");
  });

  it("returns apply failures as 500 and lets the same action retry", async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce([]);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      apply,
    });

    const failed = await request(broker, { actions: [milestone()] });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toMatchObject({
      error: "company_action_apply_failed",
      message: "database temporarily unavailable",
    });
    expect((await request(broker, { actions: [milestone()] })).status).toBe(200);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("drains an accepted slow body and closes idempotently", async () => {
    const apply = vi.fn(async () => []);
    broker = await startCompanyActionBroker({
      organizationId: "org/acme",
      attemptId: "attempt/one",
      agentId: "agent/ceo",
      apply,
    });
    const slow = await slowRequest(broker, { actions: [milestone()] });

    const firstClose = broker.close();
    const secondClose = broker.close();
    let closed = false;
    void firstClose.then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(secondClose).toBe(firstClose);
    expect(closed).toBe(false);
    const response = await slow.finish();
    await firstClose;
    expect(response.status).toBe(200);
    expect(closed).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
  });
});

async function request(
  broker: CompanyActionBroker,
  payload: unknown,
  override: { token?: string; attemptId?: string; providerSessionId?: string } = {},
) {
  return fetch(broker.env.AASPAI_COMPANY_BROKER_URL!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${override.token ?? broker.env.AASPAI_COMPANY_BROKER_TOKEN}`,
      "content-type": "application/json",
      "x-aaspai-organization-id": broker.env.AASPAI_COMPANY_ORGANIZATION_ID!,
      "x-aaspai-attempt-id": override.attemptId ?? broker.env.AASPAI_COMPANY_ATTEMPT_ID!,
      "x-aaspai-agent-id": broker.env.AASPAI_COMPANY_AGENT_ID!,
      "x-aaspai-provider-session-id": override.providerSessionId ?? "",
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

function milestone() {
  return {
    type: "create_milestone",
    projectId: "project/growth",
    title: "Qualified pipeline",
    outcome: "Ten qualified opportunities",
    sequence: 1,
    acceptance: { qualified: 10 },
  };
}

async function slowRequest(broker: CompanyActionBroker, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload));
  const split = Math.floor(body.length / 2);
  let finishBody!: () => void;
  let continueRequest!: () => void;
  const continued = new Promise<void>((resolve) => {
    continueRequest = resolve;
  });
  const response = new Promise<{ status: number }>((resolve, reject) => {
    const client = httpRequest(
      broker.env.AASPAI_COMPANY_BROKER_URL!,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${broker.env.AASPAI_COMPANY_BROKER_TOKEN}`,
          connection: "close",
          "content-type": "application/json",
          "content-length": body.length,
          expect: "100-continue",
          "x-aaspai-organization-id": broker.env.AASPAI_COMPANY_ORGANIZATION_ID!,
          "x-aaspai-attempt-id": broker.env.AASPAI_COMPANY_ATTEMPT_ID!,
          "x-aaspai-agent-id": broker.env.AASPAI_COMPANY_AGENT_ID!,
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0 }));
      },
    );
    client.once("continue", continueRequest);
    client.once("error", reject);
    client.flushHeaders();
    finishBody = () => client.end(body.subarray(split));
    client.write(body.subarray(0, split));
  });
  await continued;
  return {
    finish: () => {
      finishBody();
      return response;
    },
  };
}
