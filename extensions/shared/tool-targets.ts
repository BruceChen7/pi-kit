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

/**
 * Keys that carry one path. Order defines precedence: pi's own `path` first,
 * then the snake_case / camelCase spellings common in MCP tool schemas.
 */
const SINGLE_PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filename",
  "file",
] as const;

/** Keys that carry a list of paths (strings or `{ path }` entries). */
const PATH_LIST_KEYS = ["paths", "files"] as const;

const REMOTE_VALUE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * A usable path candidate: a non-empty string that is not a URL such as
 * `file://…` or `https://…`. MCP tools often take remote URIs in the same
 * field that local tools use for paths, and those must not become file
 * targets.
 */
const candidatePath = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || REMOTE_VALUE_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
};

const firstCandidateFromKeys = (
  input: unknown,
  keys: readonly string[],
): string | null => {
  for (const key of keys) {
    const candidate = candidatePath(stringProperty(input, key));
    if (candidate) {
      return candidate;
    }
  }

  return null;
};

const pathsFromPathList = (value: unknown): ToolTargetPath[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const direct = candidatePath(entry);
    if (direct) {
      return [{ rawPath: direct }];
    }

    const nested = firstCandidateFromKeys(entry, SINGLE_PATH_KEYS);
    return nested ? [{ rawPath: nested }] : [];
  });
};

/**
 * Extract file paths from any tool call's arguments: pi's write/edit shapes
 * (`path`, `multi[]`, `patch`) plus the keys MCP servers commonly use. Pure;
 * returns deduplicated candidates in a stable order.
 */
export const pathsFromToolArgs = (input: unknown): ToolTargetPath[] => {
  const rawPath = candidatePath(stringProperty(input, "path"));

  if (isRecord(input) && Array.isArray(input.multi) && input.multi.length > 0) {
    return dedupeTargetPaths(pathsFromMultiEdit(input.multi, rawPath));
  }

  const patch = stringProperty(input, "patch");
  if (patch) {
    return dedupeTargetPaths(pathsFromPatchHeaders(patch));
  }

  if (rawPath) {
    return [{ rawPath }];
  }

  for (const key of PATH_LIST_KEYS) {
    const listed = pathsFromPathList(isRecord(input) ? input[key] : undefined);
    if (listed.length > 0) {
      return dedupeTargetPaths(listed);
    }
  }

  const aliased = firstCandidateFromKeys(
    input,
    SINGLE_PATH_KEYS.filter((key) => key !== "path"),
  );
  return aliased ? [{ rawPath: aliased }] : [];
};
