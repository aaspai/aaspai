/**
 * STUB for the foundation slice.
 *
 * Will host the reverse-RPC tunnel that lets an in-sandbox agent CLI
 * call back to the host's API. Mirrors paperclip's
 * `sandbox-callback-bridge.ts`:
 *   - `startSandboxCallbackBridgeServer` boots a host-side worker that
 *     polls the request queue
 *   - `createCommandManagedSandboxCallbackBridgeQueueClient` translates
 *     queue ops into shell commands via the `CommandManagedRuntimeRunner`
 *   - `DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST` is the security
 *     boundary that bounds the surface area a compromised CLI could
 *     reach via the bridge
 *
 * Real implementation lands once L3 wires a controller onto this.
 */

export const CALLBACK_BRIDGE_STUB_MESSAGE =
  "Reverse-RPC callback bridge is not yet implemented in @aaspai/runtime. " +
  "It will land with the L3 session-control slice.";

export function startSandboxCallbackBridgeServer(): never {
  throw new Error(CALLBACK_BRIDGE_STUB_MESSAGE);
}

export function createCommandManagedSandboxCallbackBridgeQueueClient(): never {
  throw new Error(CALLBACK_BRIDGE_STUB_MESSAGE);
}
