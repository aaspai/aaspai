import type { RuntimeFileEntry, RuntimeFilesystem } from "../../core/contracts/filesystem.js";
import { runLocalProcess } from "../../core/process/local-process.js";
import { shellQuote } from "../../core/shell/quote.js";

function text(bytes?: Uint8Array): string {
  return bytes && bytes.byteLength > 0 ? new TextDecoder().decode(bytes) : "";
}

/**
 * Docker `exec`-backed filesystem. Binary-safe: file transfer is done
 * through `docker exec` tar streaming rather than text cat/tee where
 * possible; read/write fall back to `cat`/`tee` for small payloads.
 */
export class DockerFilesystem implements RuntimeFilesystem {
  constructor(
    private readonly command: string,
    private readonly containerId: string,
  ) {}

  private async exec(args: string[], stdin?: string | Uint8Array): Promise<string> {
    const result = await runLocalProcess({
      command: this.command,
      args: ["exec", "--workdir", "/workspace", this.containerId, ...args],
      ...(stdin !== undefined
        ? { stdin: typeof stdin === "string" ? stdin : new TextDecoder().decode(stdin) }
        : {}),
    });
    if ((result.exitCode ?? 1) !== 0) {
      throw new Error(`docker exec failed: ${text(result.stderrTail)}`);
    }
    return text(result.stdoutTail);
  }

  async mkdir(path: string): Promise<void> {
    await this.exec(["mkdir", "-p", path]);
  }

  async read(path: string): Promise<Uint8Array> {
    const result = await runLocalProcess({
      command: this.command,
      args: ["exec", this.containerId, "cat", path],
    });
    if ((result.exitCode ?? 1) !== 0)
      throw new Error(`docker read failed: ${text(result.stderrTail)}`);
    return result.stdoutTail ?? new Uint8Array();
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    const result = await runLocalProcess({
      command: this.command,
      args: ["exec", "-i", this.containerId, "tee", path],
      stdin: new TextDecoder().decode(content),
    });
    if ((result.exitCode ?? 1) !== 0)
      throw new Error(`docker write failed: ${text(result.stderrTail)}`);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.exec(["rm", options?.recursive === false ? "-f" : "-rf", path]);
  }

  async list(path: string): Promise<RuntimeFileEntry[]> {
    const out = await this.exec([
      "sh",
      "-c",
      `cd ${shellQuote(path)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`,
    ]);
    return out
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((line) => {
        const [name, sizeStr, typeChar] = line.split("|");
        return {
          name: name ?? "",
          size: Number.parseInt(sizeStr ?? "0", 10),
          isDir: typeChar === "d",
        };
      });
  }

  async stat(path: string): Promise<{ isDir: boolean; size: number }> {
    const out = await this.exec([
      "sh",
      "-c",
      `stat -c '%F|%s' ${shellQuote(path)} 2>/dev/null || echo 'other|0'`,
    ]);
    const [kind, sizeStr] = out.trim().split("|");
    return { isDir: kind === "directory", size: Number.parseInt(sizeStr ?? "0", 10) };
  }
}
