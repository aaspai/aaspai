import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CompanyAction } from "./company-actions.js";
import { companyActionPayload } from "./company-actions.js";

const MAX_REQUEST_BYTES = 65_536;
// ponytail: fixed per-attempt ceiling; make policy-driven only when real workloads need tuning.
const MAX_ACTIONS_PER_ATTEMPT = 32;

export interface AppliedCompanyAction {
  actionIndex: number;
  actionType: CompanyAction["type"];
  projectId: string;
  status: "succeeded";
  outcome: Record<string, unknown>;
}

export interface CompanyActionBroker {
  env: Record<string, string>;
  close(): Promise<void>;
}

/**
 * A loopback-only, attempt-scoped control boundary for a native CLI run.
 * The bearer token exists only in memory and dies with the broker.
 */
export async function startCompanyActionBroker(input: {
  organizationId: string;
  attemptId: string;
  agentId: string;
  requiredProviderSessionId?: string;
  apply(actions: CompanyAction[]): Promise<AppliedCompanyAction[]>;
}): Promise<CompanyActionBroker> {
  const token = randomBytes(32).toString("base64url");
  let applyQueue = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const requests = new Map<string, Promise<AppliedCompanyAction[]>>();
  const acceptedRequests = new Set<Promise<void>>();
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/company-actions") {
        return json(response, 404, { error: "not_found" });
      }
      if (!validBearer(request, token)) {
        return json(response, 401, { error: "invalid_attempt_token" });
      }
      if (
        request.headers["x-aaspai-organization-id"] !== input.organizationId ||
        request.headers["x-aaspai-attempt-id"] !== input.attemptId ||
        request.headers["x-aaspai-agent-id"] !== input.agentId
      ) {
        return json(response, 403, { error: "attempt_scope_mismatch" });
      }
      if (
        input.requiredProviderSessionId &&
        request.headers["x-aaspai-provider-session-id"] !== input.requiredProviderSessionId
      ) {
        return json(response, 403, { error: "provider_session_mismatch" });
      }

      const body = await readBody(request);
      const actions = companyActionPayload(JSON.parse(body));
      if (actions.length !== 1) throw new Error("company_action_requires_single_action");
      if (containsSecret(actions, token)) {
        throw new Error("company_action_contains_ephemeral_secret");
      }
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(canonicalize(actions)))
        .digest("hex");
      let applying = requests.get(fingerprint);
      if (!applying) {
        if (requests.size >= MAX_ACTIONS_PER_ATTEMPT) {
          throw new Error("company_action_budget_exceeded");
        }
        applying = applyQueue.then(() => input.apply(actions));
        requests.set(fingerprint, applying);
        void applying.catch(() => {
          if (requests.get(fingerprint) === applying) requests.delete(fingerprint);
        });
        applyQueue = applying.then(
          () => undefined,
          () => undefined,
        );
      }
      let results: AppliedCompanyAction[];
      try {
        results = await applying;
      } catch (error) {
        return json(response, 500, {
          error: "company_action_apply_failed",
          message: redactedMessage(error, token),
        });
      }
      return json(response, 200, {
        ok: true,
        organizationId: input.organizationId,
        attemptId: input.attemptId,
        agentId: input.agentId,
        results,
      });
    } catch (error) {
      const message = redactedMessage(error, token);
      const status =
        message === "request_too_large"
          ? 413
          : message === "company_action_budget_exceeded"
            ? 429
            : 400;
      return json(response, status, {
        error:
          status === 413
            ? "request_too_large"
            : status === 429
              ? "company_action_budget_exceeded"
              : "company_action_rejected",
        message: message.slice(0, 2_048),
      });
    }
  };
  const server = createServer((request, response) => {
    if (closing) {
      request.resume();
      return json(response, 503, { error: "company_action_broker_closing" });
    }
    const handling = handleRequest(request, response);
    acceptedRequests.add(handling);
    void handling.then(
      () => acceptedRequests.delete(handling),
      () => acceptedRequests.delete(handling),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address() as AddressInfo;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = Promise.all([
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
      Promise.allSettled([...acceptedRequests]).then(() => undefined),
    ]).then(() => undefined);
    return closePromise;
  };
  return {
    env: {
      AASPAI_COMPANY_BROKER_URL: `http://127.0.0.1:${address.port}/v1/company-actions`,
      AASPAI_COMPANY_BROKER_TOKEN: token,
      AASPAI_COMPANY_ORGANIZATION_ID: input.organizationId,
      AASPAI_COMPANY_ATTEMPT_ID: input.attemptId,
      AASPAI_COMPANY_AGENT_ID: input.agentId,
    },
    close,
  };
}

function redactedMessage(error: unknown, token: string): string {
  const unsafe = error instanceof Error ? error.message : String(error);
  return unsafe.replaceAll(token, "[REDACTED]").slice(0, 2_048);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secret));
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.entries(value as Record<string, unknown>).some(
        ([key, item]) => key.includes(secret) || containsSecret(item, secret),
      ),
  );
}

function validBearer(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(value.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES)
    throw new Error("request_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
