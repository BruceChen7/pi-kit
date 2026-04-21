function escapeForDoubleQuotes(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/(["$`])/g, "\\$1");
}

export function buildDefaultStartCommand(prompt: string): string {
  return `pi "${escapeForDoubleQuotes(prompt)}"`;
}
