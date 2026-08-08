/**
 * Binary-safe filesystem surface. Every provider that claims
 * `binaryFilesystem: true` must pass a random-byte round-trip contract
 * test. All methods are byte oriented; runtime must not assume text.
 */

export interface RuntimeFileStat {
  isDir: boolean;
  size: number;
  modifiedAt?: string;
}

export interface RuntimeFileEntry {
  name: string;
  size: number;
  isDir: boolean;
}

export interface RuntimeFilesystem {
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, content: Uint8Array): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat?(path: string): Promise<RuntimeFileStat>;
  list?(path: string): Promise<RuntimeFileEntry[]>;
  uploadFile?(localPath: string, remotePath: string): Promise<void>;
  downloadFile?(remotePath: string, localPath: string): Promise<void>;
}
