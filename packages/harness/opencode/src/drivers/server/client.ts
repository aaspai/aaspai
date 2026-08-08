import { TextDecoder } from "node:util";

/** Tested OpenCode server/API compatibility line for this release. */
export const OPENCODE_COMPATIBILITY_VERSION = "1.18.15" as const;

export interface OpenCodeServerClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  /** Ephemeral provider headers, such as a Daytona preview token. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  expectedVersion?: string | RegExp;
}

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
}

export interface OpenCodeSession {
  id: string;
  title?: string;
  parentID?: string;
  [key: string]: unknown;
}

export interface OpenCodeMessage {
  info?: { id?: string; role?: string; [key: string]: unknown };
  parts?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OpenCodeServerEvent {
  type?: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export class OpenCodeServerError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body?: unknown;

  constructor(status: number, path: string, body?: unknown) {
    super(`OpenCode server ${status} ${path}`);
    this.name = "OpenCodeServerError";
    this.status = status;
    this.path = path;
    this.body = redactSensitive(body);
  }
}

/**
 * Small, exact-version HTTP client for `opencode serve`.
 *
 * It intentionally owns no process, config file, auth store, or global
 * singleton. The runtime supplies the server URL and ephemeral credentials;
 * this class only speaks the documented API.
 */
export class OpenCodeServerClient {
  private readonly baseUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly expectedVersion?: string | RegExp;

  constructor(options: OpenCodeServerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) throw new Error("OpenCode server URL must be HTTP(S)");
    this.username = options.username;
    this.password = options.password;
    this.extraHeaders = { ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.expectedVersion = options.expectedVersion;
  }

  async health(signal?: AbortSignal): Promise<OpenCodeHealth> {
    const health = await this.request<OpenCodeHealth>("GET", "/global/health", undefined, signal);
    if (!health.healthy || typeof health.version !== "string") {
      throw new Error("OpenCode server health check failed");
    }
    if (this.expectedVersion !== undefined) {
      let matches: boolean;
      if (typeof this.expectedVersion === "string") {
        matches = health.version === this.expectedVersion;
      } else {
        this.expectedVersion.lastIndex = 0;
        matches = this.expectedVersion.test(health.version);
      }
      if (!matches) throw new Error(`unsupported OpenCode server version: ${health.version}`);
    }
    return health;
  }

  async createSession(
    input: { title?: string; parentID?: string } = {},
    signal?: AbortSignal,
  ): Promise<OpenCodeSession> {
    return await this.request<OpenCodeSession>("POST", "/session", input, signal);
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<OpenCodeSession> {
    return await this.request<OpenCodeSession>(
      "GET",
      `/session/${encodeURIComponent(sessionId)}`,
      undefined,
      signal,
    );
  }

  async listMessages(
    sessionId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<OpenCodeMessage[]> {
    const query = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
    return await this.request<OpenCodeMessage[]>(
      "GET",
      `/session/${encodeURIComponent(sessionId)}/message${query}`,
      undefined,
      signal,
    );
  }

  async promptAsync(
    sessionId: string,
    input: {
      prompt: string;
      model?: { providerID: string; modelID: string };
      variant?: string;
      agent?: string;
      noReply?: boolean;
      system?: string;
      tools?: Record<string, boolean>;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const body = {
      ...(input.model ? { model: input.model } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.noReply !== undefined ? { noReply: input.noReply } : {}),
      ...(input.system ? { system: input.system } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
      parts: [{ type: "text", text: input.prompt }],
    };
    await this.request(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      body,
      signal,
    );
  }

  async abort(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    return Boolean(
      await this.request<boolean>(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/abort`,
        {},
        signal,
      ),
    );
  }

  async fork(
    sessionId: string,
    messageID?: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeSession> {
    return await this.request<OpenCodeSession>(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/fork`,
      messageID ? { messageID } : {},
      signal,
    );
  }

  async respondPermission(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      return Boolean(
        await this.request(
          "POST",
          `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
          { response, remember: response === "always" },
          signal,
        ),
      );
    } catch (error) {
      if (!(error instanceof OpenCodeServerError) || error.status !== 404) throw error;
      // Older 1.18 builds used a global reply endpoint. Keep it only as a
      // compatibility fallback; the session-scoped endpoint above is the
      // documented API and cannot cross-answer another session.
      return Boolean(
        await this.request(
          "POST",
          `/permission/${encodeURIComponent(permissionId)}/reply`,
          { response, remember: response === "always" },
          signal,
        ),
      );
    }
  }

  async respondQuestion(
    requestId: string,
    answers: string[][],
    signal?: AbortSignal,
  ): Promise<boolean> {
    return Boolean(
      await this.request(
        "POST",
        `/question/${encodeURIComponent(requestId)}/reply`,
        { answers },
        signal,
      ),
    );
  }

  async rejectQuestion(requestId: string, signal?: AbortSignal): Promise<boolean> {
    return Boolean(
      await this.request("POST", `/question/${encodeURIComponent(requestId)}/reject`, {}, signal),
    );
  }

  /** Subscribe to the global SSE stream. The caller owns reconnect policy. */
  async *events(signal?: AbortSignal): AsyncGenerator<OpenCodeServerEvent> {
    let eventPath = "/event";
    let response = await this.fetchImpl(`${this.baseUrl}${eventPath}`, {
      method: "GET",
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
    // Older 1.18 servers documented the stream under /global/event while
    // newer releases expose the shorter /event alias. Keep the compatibility
    // probe strict, but tolerate the documented endpoint rename.
    if (response.status === 404) {
      eventPath = "/global/event";
      response = await this.fetchImpl(`${this.baseUrl}${eventPath}`, {
        method: "GET",
        headers: this.headers({ accept: "text/event-stream" }),
        signal,
      });
    }
    if (!response.ok || !response.body) {
      const body = await readBody(response);
      throw new OpenCodeServerError(response.status, eventPath, body);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let dataLines: string[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "") {
            const payload = dataLines.join("\n");
            dataLines = [];
            if (!payload || payload === "[DONE]") continue;
            try {
              const parsed = JSON.parse(payload) as OpenCodeServerEvent;
              yield parsed;
            } catch {
              // Ignore comments/keep-alives and malformed records; the
              // reconnecting driver will reconcile messages over HTTP.
            }
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.startsWith("data:")) {
        const payload = buffer.slice(5).trim();
        if (payload && payload !== "[DONE]") yield JSON.parse(payload) as OpenCodeServerEvent;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers = { ...this.extraHeaders, ...extra };
    if (this.username !== undefined && this.password !== undefined) {
      headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
    }
    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const parsed = await readBody(response);
    if (!response.ok) throw new OpenCodeServerError(response.status, path, parsed);
    return parsed as T;
  }
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
      .replace(
        /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*([^\s,;]+)/gi,
        "$1=[redacted]",
      );
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = /api[_-]?key|token|secret|password|authorization|credential/i.test(key)
      ? "[redacted]"
      : redactSensitive(child, depth + 1);
  }
  return out;
}
