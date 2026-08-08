import { assertValidEnvMap, shellQuote } from "./environment.js";

export interface LoginShellInput {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdinRedirect?: string;
  extraSourceLines?: string[];
}

/**
 * Build a login-shell script: source /etc/profile, ~/.profile,
 * ~/.bash_profile (or ~/.bashrc), ~/.zprofile, and nvm shims, then run
 * the command with the caller's env applied last so it wins.
 */
export function buildLoginShellScript(input: LoginShellInput): string {
  const args = input.args ?? [];
  const env = input.env ?? {};
  assertValidEnvMap(env);
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const commandParts = [shellQuote(input.command), ...args.map(shellQuote)].join(" ");
  const redirected = input.stdinRedirect
    ? `${commandParts} < ${shellQuote(input.stdinRedirect)}`
    : commandParts;
  const finalLine = envArgs.length > 0 ? `env ${envArgs.join(" ")} ${redirected}` : redirected;
  const lines = [
    "if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi",
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    `export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"`,
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    ...(input.extraSourceLines ?? []),
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  lines.push(finalLine);
  return lines.join(" && ");
}
