import fs from "node:fs";
import path from "node:path";

import {
  escapeTomlBasicString,
  FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
  resolveUserHomePath,
  WORKTRUNK_USER_CONFIG_RELATIVE_PATH,
} from "./shared.js";

const WT_USER_CONFIG_MANAGED_BLOCK_START =
  "# >>> pi-kit feature-workflow worktree-path (managed) >>>";
const WT_USER_CONFIG_MANAGED_BLOCK_END =
  "# <<< pi-kit feature-workflow worktree-path (managed) <<<";

export const getFeatureWorkflowWorktrunkUserConfigPath = (
  inputHomePath?: string,
): string => {
  return path.join(
    resolveUserHomePath(inputHomePath),
    WORKTRUNK_USER_CONFIG_RELATIVE_PATH,
  );
};

function buildManagedWorktrunkUserConfigBlock(): string {
  const escapedTemplate = escapeTomlBasicString(
    FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
  );

  return [
    WT_USER_CONFIG_MANAGED_BLOCK_START,
    `worktree-path = "${escapedTemplate}"`,
    WT_USER_CONFIG_MANAGED_BLOCK_END,
  ].join("\n");
}

function findManagedBlockRange(
  source: string,
  markers: { start: string; end: string },
): { startIndex: number; replacementEnd: number } | null {
  const startIndex = source.indexOf(markers.start);
  const endIndex = source.indexOf(markers.end);
  if (startIndex < 0 || endIndex <= startIndex) {
    return null;
  }

  return {
    startIndex,
    replacementEnd: endIndex + markers.end.length,
  };
}

function splitTopLevelTomlPrefix(source: string): {
  prefix: string;
  suffix: string;
} {
  const match = source.match(/^[ \t]*\[[^\n]*\]/m);
  if (!match || match.index === undefined) {
    return { prefix: source, suffix: "" };
  }

  return {
    prefix: source.slice(0, match.index),
    suffix: source.slice(match.index),
  };
}

function parseTopLevelWorktreePathLine(line: string): string | null {
  const basicMatch = line.match(
    /^\s*worktree-path\s*=\s*"([^"\n]*)"\s*(?:#.*)?$/,
  );
  if (basicMatch) {
    return basicMatch[1] ?? null;
  }

  const literalMatch = line.match(
    /^\s*worktree-path\s*=\s*'([^'\n]*)'\s*(?:#.*)?$/,
  );
  return literalMatch?.[1] ?? null;
}

function readTopLevelWorktreePathTemplate(source: string): string | null {
  const { prefix } = splitTopLevelTomlPrefix(source);
  for (const line of prefix.split(/\r?\n/)) {
    const template = parseTopLevelWorktreePathLine(line);
    if (template !== null) {
      return template;
    }
  }

  return null;
}

function removeTopLevelWorktreePathEntries(source: string): {
  content: string;
  removed: boolean;
} {
  const { prefix, suffix } = splitTopLevelTomlPrefix(source);
  const keptLines: string[] = [];
  let removed = false;

  for (const line of prefix.split(/\r?\n/)) {
    if (parseTopLevelWorktreePathLine(line) !== null) {
      removed = true;
      continue;
    }
    keptLines.push(line);
  }

  return {
    content: `${keptLines.join("\n")}${suffix}`,
    removed,
  };
}

export function upsertManagedWorktrunkUserConfig(
  existingContent: string | null,
): { content: string; changed: boolean } {
  const nextBlock = buildManagedWorktrunkUserConfigBlock();
  const source = existingContent ?? "";

  if (source.includes(nextBlock)) {
    return {
      content: source,
      changed: false,
    };
  }

  const managedRange = findManagedBlockRange(source, {
    start: WT_USER_CONFIG_MANAGED_BLOCK_START,
    end: WT_USER_CONFIG_MANAGED_BLOCK_END,
  });
  if (managedRange) {
    const nextContent =
      source.slice(0, managedRange.startIndex) +
      nextBlock +
      source.slice(managedRange.replacementEnd);
    return {
      content: nextContent,
      changed: nextContent !== source,
    };
  }

  if (
    readTopLevelWorktreePathTemplate(source) ===
    FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE
  ) {
    return {
      content: source,
      changed: false,
    };
  }

  const stripped = removeTopLevelWorktreePathEntries(source).content;
  const remainder = stripped.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
  const nextContent = remainder
    ? `${nextBlock}\n\n${remainder}\n`
    : `${nextBlock}\n`;

  return {
    content: nextContent,
    changed: nextContent !== source,
  };
}

export const getFeatureWorkflowWorktrunkUserConfigStatus = (
  input: { userHomePath?: string } = {},
): {
  path: string;
  currentTemplate: string | null;
  needsUpdate: boolean;
} => {
  const userConfigPath = getFeatureWorkflowWorktrunkUserConfigPath(
    input.userHomePath,
  );
  if (!fs.existsSync(userConfigPath)) {
    return {
      path: userConfigPath,
      currentTemplate: null,
      needsUpdate: true,
    };
  }

  const source = fs.readFileSync(userConfigPath, "utf-8");
  const managedRange = findManagedBlockRange(source, {
    start: WT_USER_CONFIG_MANAGED_BLOCK_START,
    end: WT_USER_CONFIG_MANAGED_BLOCK_END,
  });
  if (managedRange) {
    const managedBlock = source.slice(
      managedRange.startIndex,
      managedRange.replacementEnd,
    );
    const currentTemplate = readTopLevelWorktreePathTemplate(managedBlock);
    return {
      path: userConfigPath,
      currentTemplate,
      needsUpdate:
        currentTemplate !== FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
    };
  }

  const currentTemplate = readTopLevelWorktreePathTemplate(source);
  return {
    path: userConfigPath,
    currentTemplate,
    needsUpdate:
      currentTemplate !== FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
  };
};
