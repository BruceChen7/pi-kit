export type ToolTargetPath = {
  rawPath: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringProperty = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  const property = value[key];
  return typeof property === "string" ? property : null;
};

const dedupeTargetPaths = (paths: ToolTargetPath[]): ToolTargetPath[] => {
  const seen = new Set<string>();
  return paths.filter(({ rawPath }) => {
    if (seen.has(rawPath)) {
      return false;
    }
    seen.add(rawPath);
    return true;
  });
};

const pathsFromMultiEdit = (
  multi: unknown[],
  inheritedPath: string | null,
): ToolTargetPath[] =>
  multi.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const rawPath = stringProperty(entry, "path") ?? inheritedPath;
    return rawPath ? [{ rawPath }] : [];
  });

const pathsFromPatchHeaders = (patch: string): ToolTargetPath[] => {
  const paths: ToolTargetPath[] = [];
  const headerPattern = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu;
  for (const match of patch.matchAll(headerPattern)) {
    const rawPath = match[1]?.trim();
    if (rawPath) {
      paths.push({ rawPath });
    }
  }
  return paths;
};

export const pathsFromWriteToolInput = (input: unknown): ToolTargetPath[] => {
  const rawPath = stringProperty(input, "path");

  if (isRecord(input) && Array.isArray(input.multi)) {
    return dedupeTargetPaths(pathsFromMultiEdit(input.multi, rawPath));
  }

  const patch = stringProperty(input, "patch");
  if (patch) {
    return dedupeTargetPaths(pathsFromPatchHeaders(patch));
  }

  return rawPath ? [{ rawPath }] : [];
};
