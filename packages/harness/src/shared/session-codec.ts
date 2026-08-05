import type { AdapterSessionCodec } from "@aaspai/contracts/harness";

type SessionCodecOptions = {
  idKeys: string[];
  canonicalId: string;
  fields?: string[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function createSessionCodec(options: SessionCodecOptions): AdapterSessionCodec {
  const normalize = (raw: unknown): Record<string, unknown> | null => {
    const input = record(raw);
    if (!input) return null;
    const id = options.idKeys.map((key) => stringValue(input[key])).find(Boolean);
    if (!id) return null;
    const result: Record<string, unknown> = { [options.canonicalId]: id };
    for (const key of options.fields!) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) result[key] = value.trim();
      else if (Array.isArray(value) && value.length > 0) result[key] = value;
    }
    return result;
  };
  return {
    deserialize: normalize,
    serialize: normalize,
    getDisplayId: (params) =>
      (normalize(params)?.[options.canonicalId] as string | undefined) ?? null,
  };
}

function preserveSessionCodec(idKeys: string[]): AdapterSessionCodec {
  const normalize = (raw: unknown): Record<string, unknown> | null => {
    const input = record(raw);
    if (!input) return null;
    const id = idKeys.map((key) => stringValue(input[key])).find(Boolean);
    return id ? { ...input, sessionId: id } : null;
  };
  return {
    deserialize: normalize,
    serialize: normalize,
    getDisplayId: (params) => (normalize(params)?.sessionId as string | undefined) ?? null,
  };
}

export const localSessionCodec = createSessionCodec({
  idKeys: ["sessionId", "session_id", "sessionID", "nativeSessionId", "threadId", "thread_id"],
  canonicalId: "sessionId",
  fields: ["cwd", "workspaceId", "repoUrl", "repoRef"],
});

export const acpSessionCodec = preserveSessionCodec([
  "acpSessionId",
  "backendSessionId",
  "agentSessionId",
  "runtimeSessionName",
  "cliSessionId",
  "nativeSessionId",
  "sessionId",
]);

export const cursorCloudSessionCodec = createSessionCodec({
  idKeys: ["cursorAgentId", "agentId", "sessionId"],
  canonicalId: "cursorAgentId",
  fields: ["latestRunId", "runtime", "envType", "envName", "repos"],
});

export const hermesSessionCodec = createSessionCodec({
  idKeys: ["hermesSessionId", "sessionId", "session_id"],
  canonicalId: "hermesSessionId",
  fields: ["hermesRunId"],
});

export const openclawSessionCodec = createSessionCodec({
  idKeys: ["sessionKey", "sessionId"],
  canonicalId: "sessionKey",
  fields: ["runId"],
});

export const opencodeSessionCodec = preserveSessionCodec([
  "sessionId",
  "session_id",
  "cliSessionId",
]);
