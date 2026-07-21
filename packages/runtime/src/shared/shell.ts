/**
 * Tiny shell helper. Returns the right `shell -c` args for an arbitrary
 * script so callers can do `spawn(shell, shellCommandArgs(script))`
 * without branching on platform.
 */
export function preferredShellForSandbox(
  shellCommand: string | null | undefined,
): "bash" | "sh" {
  return shellCommand === "bash" ? "bash" : "sh";
}

export function shellCommandArgs(script: string): string[] {
  return ["-c", script];
}

/** Single-quote-with-embedded-single-quote escape. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
