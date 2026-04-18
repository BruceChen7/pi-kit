export const GITIGNORE_FILE = ".gitignore";
export const GITIGNORE_PI_ENTRY = ".pi/";

export type BuildGitignoreContentResult = {
  content: string;
  changed: boolean;
  addedEntry: boolean;
};

const normalizeGitignoreEntry = (value: string): string =>
  value.trim().replace(/\/+$/, "");

export const buildGitignoreContent = (
  existingContent: string | null,
): BuildGitignoreContentResult => {
  const lines = existingContent === null ? [] : existingContent.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const hasPiEntry = lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return false;
    }

    return normalizeGitignoreEntry(trimmed) === ".pi";
  });

  if (hasPiEntry) {
    return {
      content: existingContent ?? "",
      changed: false,
      addedEntry: false,
    };
  }

  const next = [...lines];
  if (next.length > 0 && next[next.length - 1] !== "") {
    next.push("");
  }
  next.push(GITIGNORE_PI_ENTRY);

  return {
    content: `${next.join("\n")}\n`,
    changed: true,
    addedEntry: true,
  };
};
