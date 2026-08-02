import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeReviewInput } from "@aaspai/contracts/knowledge";
import { createKnowledgeReviewPost } from "../app/api/knowledge/proposals/[id]/review/route";

test("proposal review requires authentication", async () => {
  const post = createKnowledgeReviewPost({
    getUser: async () => null,
    ensureWorkspace: () => assert.fail("workspace must not be opened before authentication"),
  });

  const response = await post(new Request("http://local/api", { method: "POST" }), {
    params: Promise.resolve({ id: "proposal_1" }),
  });

  assert.equal(response.status, 401);
});

test("proposal review uses the authenticated actor and organization", async () => {
  let reviewed: KnowledgeReviewInput | undefined;
  const post = createKnowledgeReviewPost({
    getUser: async () => ({ id: "user_owner", organizationId: "org_owner" }),
    ensureWorkspace: () => {},
    isWorkspace: () => true,
    review: async (input) => {
      reviewed = input;
      return { status: "accepted" };
    },
  });

  const response = await post(
    new Request("http://local/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationId: "org_attacker",
        actorId: "user_attacker",
        proposalId: "proposal_attacker",
        action: "accept",
        reason: "Founder approved",
      }),
    }),
    { params: Promise.resolve({ id: "proposal_real" }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(reviewed, {
    organizationId: "org_owner",
    actorId: "user_owner",
    proposalId: "proposal_real",
    action: "accept",
    reason: "Founder approved",
  });
});
