import { preferredShellForSandbox, shellCommandArgs } from "./shell.js";

/**
 * Build a script that installs an npm package globally inside a sandbox
 * shell. Falls back to a portable Node.js tarball if `npm` is not on
 * `$PATH` (so a freshly-provisioned sandbox does not need a system
 * package manager).
 *
 * Mirrors the intent of paperclip's `buildSandboxNpmInstallCommand` —
 * we keep the public shape (string in, string out) so swap is trivial.
 */
export function buildSandboxNpmInstallCommand(packageName: string): string {
  const shell = preferredShellForSandbox("bash");
  void shell;
  void shellCommandArgs;
  if (!/^@?[a-z0-9][a-z0-9._/-]*$/i.test(packageName)) {
    throw new Error(`Refusing to install invalid npm package name: ${packageName}`);
  }
  return [
    "set -eu",
    "if command -v npm >/dev/null 2>&1; then",
    `  NPM="npm"`,
    "else",
    `  if [ -x "$HOME/.local/bin/npm" ]; then NPM="$HOME/.local/bin/npm";`,
    `  else`,
    `    NODE_VERSION="${DEFAULT_NODE_VERSION}"`,
    `    mkdir -p "$HOME/.local" && cd /tmp && curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o node.tar.xz && tar -xJf node.tar.xz && cp -r "node-v$NODE_VERSION-linux-x64/bin" "$HOME/.local/bin/" && cp -r "node-v$NODE_VERSION-linux-x64/lib" "$HOME/.local/lib/" && export PATH="$HOME/.local/bin:$PATH" && NPM="$HOME/.local/bin/npm";`,
    `  fi`,
    "fi",
    `if [ "$(id -u)" = "0" ]; then $NPM install -g ${packageName};`,
    `elif command -v sudo >/dev/null 2>&1; then sudo -E $NPM install -g ${packageName};`,
    `else $NPM install -g --prefix "$HOME/.local" ${packageName}; fi`,
  ].join("\n");
}

const DEFAULT_NODE_VERSION = "22.11.0";
