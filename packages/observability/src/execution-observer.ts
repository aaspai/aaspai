export type ExecutionLane = "system" | "company" | "work";
export type ToolOrigin = "aaspai" | "agent_native" | "mcp";

export interface ObservedExecutionEvent {
  id: string;
  seq: number;
  ts: string;
  lane: ExecutionLane;
  origin: ToolOrigin | "runtime";
  kind: "lifecycle" | "progress" | "tool_call" | "tool_result" | "artifact" | "alert";
  name: string;
  status?: string;
  payload: Record<string, unknown>;
}

export const COMPANY_TOOL_CATALOG = Object.freeze({
  company_action: {
    description: "Submit one or more governed company changes",
    effects: ["validate authority", "apply durable company state", "record governance evidence"],
  },
  create_milestone: {
    description: "Create a measurable project milestone",
    effects: ["create milestone", "attach manager ownership and acceptance criteria"],
  },
  define_and_start_process: {
    description: "Bind a repeatable process and start its first run",
    effects: ["bind process revision", "create process run and work items"],
  },
  hire_and_delegate: {
    description: "Hire an agent and create its delegated project task",
    effects: ["create agent", "assign project role", "create child work item", "queue new session"],
  },
});

export type CompanyToolName = keyof typeof COMPANY_TOOL_CATALOG;

export function classifyTool(name: string): { lane: "company" | "work"; origin: ToolOrigin } {
  const normalized = name.trim().toLowerCase();
  if (normalized in COMPANY_TOOL_CATALOG || normalized.startsWith("company.")) {
    return { lane: "company", origin: "aaspai" };
  }
  if (normalized.startsWith("mcp__") || normalized.startsWith("mcp.")) {
    return { lane: "work", origin: "mcp" };
  }
  return { lane: "work", origin: "agent_native" };
}

export function toolNameFromPayload(payload: Record<string, unknown>): string | null {
  for (const value of [payload.tool, payload.name, payload.toolName]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  const part = isRecord(payload.part) ? payload.part : null;
  for (const value of [part?.tool, part?.name]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function observeExecution(input: {
  executionEvents: Array<{
    id: string | number;
    seq: number;
    ts: string;
    type: string;
    payload: Record<string, unknown>;
  }>;
  sessionEvents: Array<{
    id: string | number;
    seq: number;
    ts: string;
    kind: string;
    payload: Record<string, unknown>;
  }>;
}): ObservedExecutionEvent[] {
  const observed: ObservedExecutionEvent[] = input.executionEvents.map((event) => {
    const lane = event.payload.plane === "company" ? "company" : "system";
    return {
      id: `execution:${event.id}`,
      seq: event.seq,
      ts: event.ts,
      lane,
      origin: lane === "company" ? "aaspai" : "runtime",
      kind: event.type.includes("artifact")
        ? "artifact"
        : event.type.includes("failed") || event.type.includes("stalled")
          ? "alert"
          : "lifecycle",
      name: event.type,
      status: typeof event.payload.status === "string" ? event.payload.status : undefined,
      payload: event.payload,
    };
  });

  for (const event of input.sessionEvents) {
    const tool = toolNameFromPayload(event.payload);
    const kind =
      event.kind === "tool_call" || event.kind === "tool_result" ? event.kind : "progress";
    const classification = tool ? classifyTool(tool) : null;
    observed.push({
      id: `session:${event.id}`,
      seq: event.seq,
      ts: event.ts,
      lane: classification?.lane ?? "work",
      origin: classification?.origin ?? "agent_native",
      kind,
      name: tool ?? event.kind,
      status: typeof event.payload.status === "string" ? event.payload.status : undefined,
      payload: event.payload,
    });
  }

  return observed.sort(
    (left, right) => left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
