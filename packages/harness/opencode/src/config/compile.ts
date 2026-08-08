import type { OpenCodeResolvedConfig } from "./resolve.js";

export interface ConfigInjection {
  extraEnv: Record<string, string>;
  cleanup: () => void;
}

/**
 * Compile only caller-prepared native config. The adapter never writes
 * auth files, provider files, skills, MCP files, or a global OpenCode config.
 */
export function buildOpencodeJson(config: OpenCodeResolvedConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config.nativeConfig };
  if (config.permissions && Object.keys(config.permissions).length > 0) {
    out.permission = {
      ...((out.permission as Record<string, unknown> | undefined) ?? {}),
      ...config.permissions,
    };
  }
  if (config.pure) out.pure = true;
  return out;
}

export function prepareConfigInjection(config: OpenCodeResolvedConfig): ConfigInjection {
  const document = buildOpencodeJson(config);
  assertSecretFreePreparedConfig(document);
  const extraEnv: Record<string, string> = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(document),
  };
  if (config.disableProjectConfig) extraEnv.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  return { extraEnv, cleanup: () => undefined };
}

function assertSecretFreePreparedConfig(value: unknown, path = "config", depth = 0): void {
  if (depth > 8) throw new Error(`prepared OpenCode config is too deeply nested at ${path}`);
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return;
  if (typeof value === "string") {
    if (
      /\bBearer\s+\S+|\bsk-[A-Za-z0-9]|api[_-]?key\s*[:=]|token\s*[:=]|secret\s*[:=]/i.test(value)
    )
      throw new Error(`prepared OpenCode config contains a resolved secret at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertSecretFreePreparedConfig(item, `${path}[${index}]`, depth + 1);
    });
    return;
  }
  if (typeof value !== "object") throw new Error(`unsupported OpenCode config value at ${path}`);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      /(api[_-]?key|(?:access|refresh)[_-]?token|password|secret|authorization|credential)/i.test(
        key,
      )
    ) {
      if (typeof child !== "string" || !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(child))
        throw new Error(`prepared OpenCode config contains a resolved secret at ${path}.${key}`);
    }
    assertSecretFreePreparedConfig(child, `${path}.${key}`, depth + 1);
  }
}
