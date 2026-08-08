import type { AuthVerifier } from "@aaspai/auth";
import { listAdapters } from "@aaspai/harness";
import { defaultRuntimeRegistry } from "@aaspai/runtime";
import type { Hono } from "hono";
import { authenticate } from "./auth.js";

export function registerProviderRoutes(app: Hono, options: { authVerifier?: AuthVerifier } = {}) {
  app.get("/v1/providers/capabilities", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const runtimes = defaultRuntimeRegistry()
      .list()
      .map(({ manifest }) => ({
        kind: manifest.type === "local" ? "local" : "sandbox",
        ...(manifest.type === "local" ? {} : { provider: manifest.type }),
        label: manifest.label,
        status: manifest.status === "ready" ? "ready" : "stub",
        capabilities: manifest.capabilities,
      }));
    return c.json({ data: { adapters: listAdapters(), runtimes } });
  });
}
