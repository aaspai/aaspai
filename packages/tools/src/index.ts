import { BUILT_IN_TOOLS } from "./built-in.js";
import { ToolRegistry } from "./registry.js";
export { ToolRegistry, type ToolResolution } from "./registry.js";
export { BUILT_IN_TOOLS } from "./built-in.js";

/** A registry preloaded with the built-in tool set. */
export function createBuiltInRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const tool of BUILT_IN_TOOLS) reg.register(tool);
  return reg;
}
