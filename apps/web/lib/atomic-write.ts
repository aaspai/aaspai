import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomically write a file: write to a temp sibling then rename over the
 * target. Rename is atomic on POSIX and Windows (same volume), so a
 * crash mid-write never leaves a truncated `.env` / config / auth file,
 * and concurrent writers can't interleave partial content.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try {
      await import("node:fs/promises").then(({ rm }) => rm(tmp, { force: true }));
    } catch {
      /* ignore */
    }
    throw err;
  }
}
