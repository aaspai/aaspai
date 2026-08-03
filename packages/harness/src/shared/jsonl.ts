/** Incrementally split a UTF-8 text stream into complete JSONL lines. */
export function createJsonlFramer(): {
  push(chunk: string): string[];
  flush(): string[];
} {
  let buffer = "";

  const takeLines = (): string[] => {
    const lines: string[] = [];
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      newline = buffer.indexOf("\n");
    }
    return lines;
  };

  return {
    push(chunk) {
      buffer += chunk;
      return takeLines();
    },
    flush() {
      const lines = takeLines();
      if (buffer.length > 0) {
        lines.push(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        buffer = "";
      }
      return lines;
    },
  };
}
