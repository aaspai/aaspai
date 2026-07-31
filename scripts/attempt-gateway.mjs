import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";

// Development and acceptance gateway. Production should deploy the same HTTP contract
// behind durable storage, rate limits, budget enforcement, and managed secrets.
const controlToken = process.env.GATEWAY_CONTROL_TOKEN;
const upstreamKey = process.env.OPENROUTER_API_KEY;
const port = Number(process.env.GATEWAY_PORT || 8787);
if (!controlToken || !upstreamKey) throw new Error("gateway credentials missing");

const credentials = new Map();
const audit = { issued: 0, revoked: 0, proxied: 0, rejected: 0 };

function authorized(request, token) {
  return request.headers.authorization === `Bearer ${token}`;
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

http
  .createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://gateway");
      if (url.pathname === "/health") return json(response, 200, { ok: true });
      if (url.pathname === "/audit") {
        if (!authorized(request, controlToken))
          return json(response, 401, { error: "unauthorized" });
        return json(response, 200, audit);
      }
      if (request.method === "POST" && url.pathname === "/v1/attempt-credentials") {
        if (!authorized(request, controlToken))
          return json(response, 401, { error: "unauthorized" });
        const input = JSON.parse((await body(request)).toString("utf8"));
        if (!input.attemptId || !input.organizationId)
          return json(response, 400, { error: "invalid" });
        const id = randomUUID();
        const token = createHmac("sha256", controlToken)
          .update(`${input.organizationId}:${input.attemptId}`)
          .digest("hex");
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        credentials.set(id, { token, expiresAt, revoked: false });
        audit.issued += 1;
        return json(response, 201, { id, token, expiresAt });
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/v1/attempt-credentials/")) {
        if (!authorized(request, controlToken))
          return json(response, 401, { error: "unauthorized" });
        const credential = credentials.get(decodeURIComponent(url.pathname.split("/").at(-1)));
        if (!credential) return json(response, 404, { error: "missing" });
        credential.revoked = true;
        audit.revoked += 1;
        return json(response, 200, { revoked: true });
      }

      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      const credential = [...credentials.values()].find((entry) => entry.token === token);
      if (!credential || credential.revoked || Date.parse(credential.expiresAt) <= Date.now()) {
        audit.rejected += 1;
        return json(response, 401, { error: "invalid attempt credential" });
      }
      audit.proxied += 1;
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value && !["host", "authorization", "content-length"].includes(key)) {
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
        }
      }
      headers.set("authorization", `Bearer ${upstreamKey}`);
      const upstream = await fetch(`https://openrouter.ai/api${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await body(request),
      });
      const responseBody = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(responseBody);
    } catch (error) {
      json(response, 500, { error: String(error) });
    }
  })
  .listen(port, "0.0.0.0");
