import { defineConfig } from "@aaspai/config";

export default defineConfig({
  database: {
    url: process.env.AASPAI_DB ?? "sqlite:./.aaspai/state.db",
  },
  organization: {
    id: "default",
    name: "Aaspai Project",
  },
  defaults: {
    adapter: "claude_local",
    runtime: { kind: "local" },
  },
  agents: { root: "./.aaspai/agents" },
  knowledge: { root: "./.aaspai/knowledge" },
  loops: { root: "./.aaspai/loops" },
});
