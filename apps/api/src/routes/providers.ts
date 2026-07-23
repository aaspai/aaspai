import type { AuthVerifier } from "@aaspai/auth";
import { listAdapters } from "@aaspai/harness";
import { listRuntimeTargets } from "@aaspai/runtime";
import type { Hono } from "hono";
import { authenticate } from "./auth.js";

export function registerProviderRoutes(app: Hono, options: { authVerifier?: AuthVerifier } = {}) {
  app.get("/v1/providers/capabilities", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    return c.json({ data: { adapters: listAdapters(), runtimes: listRuntimeTargets() } });
  });
}
