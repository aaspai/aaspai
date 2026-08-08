import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  RuntimeFileEntry,
  RuntimeFileStat,
  RuntimeFilesystem,
} from "../contracts/filesystem.js";

/**
 * Host-filesystem implementation of `RuntimeFilesystem`.
 *
 * Paths use the same convention as remote providers: `/foo` means `foo`
 * below the workspace root. Every operation performs both lexical and
 * real-path containment checks, so `..` and symlink escapes cannot leave the
 * root. Writes are staged in the destination directory and renamed into
 * place, giving callers an atomic replacement for regular files.
 */
export class LocalFilesystem implements RuntimeFilesystem {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    if (!baseDir || baseDir.includes("\0")) throw new Error("invalid filesystem root");
    this.baseDir = resolve(baseDir);
  }

  private lexical(path: string): string {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
      throw new Error("invalid filesystem path");
    }
    // POSIX-style absolute paths are workspace-rooted. Drive/UNC paths are
    // rejected rather than being silently reinterpreted on Windows.
    const portable = path.replaceAll("\\", "/");
    if (/^[A-Za-z]:\//.test(portable) || portable.startsWith("//")) {
      throw new Error(`absolute filesystem path is not allowed: ${JSON.stringify(path)}`);
    }
    const relativePath = portable.replace(/^\/+/, "");
    const candidate = resolve(this.baseDir, relativePath);
    const rel = relative(this.baseDir, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`filesystem path escapes workspace: ${JSON.stringify(path)}`);
    }
    return candidate;
  }

  private async contained(path: string, options: { allowMissing?: boolean } = {}): Promise<string> {
    const candidate = this.lexical(path);
    const root = await realpath(this.baseDir);
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(candidate);
    } catch (error) {
      if (!options.allowMissing) throw error;
      await this.assertExistingAncestorInside(root, candidate, path);
      resolvedPath = candidate;
    }
    this.assertInside(root, resolvedPath, path);
    return candidate;
  }

  private async containedParent(path: string): Promise<string> {
    const candidate = this.lexical(path);
    if (candidate === this.baseDir) return candidate;
    const root = await realpath(this.baseDir);
    // Resolve the nearest existing ancestor after following symlinks. The
    // final path may not exist yet, but no existing parent may escape root.
    await this.assertExistingAncestorInside(root, dirname(candidate), path);
    return candidate;
  }

  private assertInside(root: string, candidate: string, original: string): void {
    const rel = relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`filesystem symlink escapes workspace: ${JSON.stringify(original)}`);
    }
  }

  private async assertExistingAncestorInside(
    root: string,
    candidate: string,
    original: string,
  ): Promise<void> {
    let current = candidate;
    while (true) {
      try {
        const resolved = await realpath(current);
        this.assertInside(root, resolved, original);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }

  async mkdir(path: string): Promise<void> {
    const candidate = this.lexical(path);
    await this.containedParent(path);
    await mkdir(candidate, { recursive: true });
    await this.contained(path);
  }

  async read(path: string): Promise<Uint8Array> {
    const candidate = await this.contained(path);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed");
    return new Uint8Array(await readFile(candidate));
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    const candidate = this.lexical(path);
    await this.containedParent(path);
    await mkdir(dirname(candidate), { recursive: true });
    const temporary = `${candidate}.aaspai-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, candidate);
    } catch (error) {
      // Windows cannot atomically replace an existing file with rename in
      // every filesystem implementation. Keep the same containment checks
      // and fall back to a direct replacement only when necessary.
      if (
        error instanceof Error &&
        /EEXIST|EPERM|ENOTEMPTY/.test((error as NodeJS.ErrnoException).code ?? error.message)
      ) {
        await writeFile(candidate, content, { mode: 0o600 });
        await rm(temporary, { force: true }).catch(() => undefined);
      } else {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    await this.contained(path);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const lexical = this.lexical(path);
    if (lexical === this.baseDir) {
      throw new Error("removing the workspace root is not allowed");
    }
    const candidate = await this.contained(path);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed");
    await rm(candidate, { recursive: options?.recursive ?? true, force: true });
  }

  async stat(path: string): Promise<RuntimeFileStat> {
    const candidate = await this.contained(path);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed");
    return { isDir: info.isDirectory(), size: info.size, modifiedAt: info.mtime.toISOString() };
  }

  async list(path: string): Promise<RuntimeFileEntry[]> {
    const candidate = await this.contained(path);
    const directory = await lstat(candidate);
    if (!directory.isDirectory()) throw new Error("filesystem path is not a directory");
    const entries = await readdir(candidate, { withFileTypes: true });
    const out: RuntimeFileEntry[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${entry.name}`);
      const child = await this.contained(`${path.replace(/[\\/]$/, "")}/${entry.name}`);
      const info = await lstat(child);
      out.push({ name: entry.name, size: info.size, isDir: info.isDirectory() });
    }
    return out;
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.write(remotePath, new Uint8Array(await readFile(localPath)));
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await writeFile(localPath, await this.read(remotePath));
  }
}
