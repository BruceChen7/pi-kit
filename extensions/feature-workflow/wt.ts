const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function buildWtSwitchCreateArgs(input: {
  branch: string;
  base: string;
}): string[] {
  return [
    "switch",
    "--create",
    input.branch,
    "--base",
    input.base,
    "--no-cd",
    "--yes",
  ];
}

export function parseWtJsonResult(
  stdout: string,
): Record<string, unknown> | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (!line.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // continue searching
    }
  }

  return null;
}
