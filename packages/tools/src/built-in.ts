/**
 * Built-in tools. The foundation slice ships the read-only and
 * session-control tools. The rest (file writes, bash, web fetch,
 * db query) are stubs that return clear "not yet implemented"
 * errors — they are wired in Phase 3 once the per-tool execution
 * contract is settled.
 */
import type { Tool } from "@aaspai/contracts/phase2";

function stubTool(name: string, description: string, risk: Tool["risk"]): Tool {
  return {
    name,
    description,
    risk,
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    execute: async () => {
      throw new Error(`Tool "${name}" is a stub in @aaspai/tools. Wire up in Phase 3.`);
    },
  };
}

export const BUILT_IN_TOOLS: readonly Tool[] = [
  // Safe read tools (real impls can come later)
  {
    name: "ListSkills",
    description: "List all skills available to the current session.",
    risk: "safe",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("Wire to SkillRegistry in Phase 3.");
    },
  },
  {
    name: "ListAgents",
    description: "List all agents in the current organization.",
    risk: "safe",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("Wire to AgentConfigSource in Phase 3.");
    },
  },
  {
    name: "Read",
    description: "Read the contents of a file. In-sandbox only.",
    risk: "safe",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    execute: async (input) => {
      throw new Error("Wire to harness file reader in Phase 3.");
    },
  },
  // Side-effect tools (stubs)
  stubTool("Write", "Write content to a file. In-sandbox only.", "side_effect"),
  stubTool("Edit", "Edit a file by applying a diff. In-sandbox only.", "side_effect"),
  stubTool("Bash", "Execute a shell command in the session's working directory.", "side_effect"),
  // Network tools (stubs)
  stubTool("WebFetch", "Fetch a URL and return its content.", "network"),
  stubTool("WebSearch", "Search the web and return results.", "network"),
  // Platform tools (stubs)
  stubTool("QueryDb", "Run a read-only SQL query against the platform database.", "safe"),
  stubTool("ListTables", "List dynamic tables in the current organization.", "safe"),
  // Session control
  {
    name: "AskUserQuestion",
    description: "Pause the session and ask the human a question. Returns when the human answers.",
    risk: "safe",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
    },
    execute: async () => {
      throw new Error("Wire to sessions.onQuestion in Phase 3.");
    },
  },
  {
    name: "Yield",
    description: "Pause the session and let the orchestrator decide what to do next.",
    risk: "safe",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("Wire to sessions.onQuestion in Phase 3.");
    },
  },
] as const;
