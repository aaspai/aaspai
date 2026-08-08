/**
 * Safe path helpers for remote filesystems. Providers should sanitize
 * user-supplied remote paths against traversal and absolute-path escapes
 * before shelling out.
 */

import { isAbsolute, posix, win32 } from "node:path";

/**
 * Reject absolute paths and traversal (..) segments. Returns the path if
 * safe; throws otherwise. `root` (optional) anchors a relative path.
 */
export function assertSafeRemotePath(
  path: string,
  root?: string,
  options: { windows?: boolean; allowAbsolute?: boolean } = { windows: false },
): string {
  if (path.length === 0) throw new Error("empty remote path");
  if (path.includes("\0")) throw new Error("remote path contains a NUL byte");
  const portable = path.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`remote path escapes root: ${JSON.stringify(path)}`);
  }
  const absolute = isAbsolute(portable) || win32.isAbsolute(path) || portable.startsWith("~");
  if (absolute && root === undefined && !options.allowAbsolute) {
    throw new Error(`remote path must be relative, got ${JSON.stringify(path)}`);
  }
  const rootPath = root ? posix.normalize(root.replaceAll("\\", "/")) : undefined;
  // A leading slash is a provider convention for a path relative to the
  // workspace root, not permission to escape it. Strip it before joining.
  if (absolute && root === undefined && options.allowAbsolute) {
    const absoluteNormalized = posix.normalize(portable);
    if (
      absoluteNormalized === ".." ||
      absoluteNormalized.startsWith("../") ||
      !absoluteNormalized.startsWith("/")
    ) {
      throw new Error(`remote path escapes root: ${JSON.stringify(path)}`);
    }
    return absoluteNormalized;
  }
  const relativeInput = absolute ? portable.replace(/^\/+/, "") : portable;
  const normalized = posix.normalize(relativeInput);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`remote path escapes root: ${JSON.stringify(path)}`);
  }
  if (!rootPath) return normalized;
  const candidate = posix.join(rootPath, normalized);
  const rel = posix.relative(rootPath, candidate);
  if (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) {
    throw new Error(`remote path escapes root: ${JSON.stringify(path)}`);
  }
  void options;
  return candidate;
}

/** Join a base + relative segments, rejecting escapes. */
export function safeJoin(base: string, ...parts: string[]): string {
  if (parts.some((part) => part.includes("\0"))) throw new Error("path contains a NUL byte");
  const joined = posix.join(
    base.replaceAll("\\", "/"),
    ...parts.map((part) => part.replaceAll("\\", "/")),
  );
  const normalizedBase = posix.normalize(base.replaceAll("\\", "/"));
  const basePrefix = normalizedBase === "/" ? "/" : normalizedBase.replace(/\/+$/, "");
  const inside = basePrefix === "/" ? joined.startsWith("/") : joined.startsWith(`${basePrefix}/`);
  if (!inside && joined !== basePrefix) {
    throw new Error(`path escapes base: ${JSON.stringify(parts.join("/"))}`);
  }
  return joined;
}

/** Assert an env-key (single regex check without import cycle). */
export function assertSafeEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${JSON.stringify(key)}`);
  }
}
