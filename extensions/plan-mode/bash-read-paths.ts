/**
 * Working-tree files a shell command read, for the read-before-write registry.
 *
 * The registry only sees pi's `read` tool, so an agent that inspects a file
 * with `sed -n '1,80p' f` looks like it never read `f` and its first edit is
 * blocked. This recovers the paths from the command itself.
 *
 * Deliberately conservative: content-printing commands only, no redirects, no
 * in-place writes, no pattern scans, and no guessing at directories the shell
 * would compute (`cd $VAR`, `cd -`, `~`). Missing a read costs one extra round
 * trip; inventing a read that never happened lets an edit overwrite unseen
 * content.
 */

import path from "node:path";

const READ_CONTENT_COMMANDS = new Set([
  "awk",
  "bat",
  "batcat",
  "cat",
  "cut",
  "head",
  "nl",
  "sed",
  "tail",
]);

const COMMAND_SEGMENT_SPLIT = /\s*(?:&&|\|\||[;|\n])\s*/;
const TOKEN_PATTERN = /'[^']*'|"[^"]*"|\S+/g;
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RANGE_PATTERN = /^[\d,$]+p?$/;

const unquote = (token: string): string => token.replace(/^['"]|['"]$/g, "");

/** `sed -i` / `-ni` / `-in.bak` rewrite the file; reading it is not a read. */
const isInPlaceFlag = (command: string, token: string): boolean =>
  /^--in-place/.test(token) ||
  /^-i(\.|$)/.test(token) ||
  (command === "sed" && /^-[^-]*i/.test(token));

const isPathShaped = (token: string): boolean =>
  !token.startsWith("-") &&
  !token.startsWith("~") &&
  !RANGE_PATTERN.test(token) &&
  !/[$*?()[\]{}]/.test(token);

const resolveIn = (directory: string | null, token: string): string | null => {
  if (token.startsWith("/")) return token;
  if (directory === null) return null;
  return path.posix.join(directory, token);
};

const pathsFromSegment = (
  segment: string,
  directory: string | null,
): string[] => {
  const tokens = segment.match(TOKEN_PATTERN) ?? [];
  let index = 0;
  while (index < tokens.length && ASSIGNMENT_PATTERN.test(tokens[index]))
    index++;

  const command = tokens[index];
  if (!command || !READ_CONTENT_COMMANDS.has(command)) return [];

  const args = tokens.slice(index + 1).map(unquote);
  if (args.some((token) => isInPlaceFlag(command, token))) return [];

  return args
    .filter(isPathShaped)
    .map((token) => resolveIn(directory, token))
    .filter((resolved): resolved is string => resolved !== null);
};

/** Directory a `cd` segment moves into, or undefined when it is not a `cd`. */
const directoryAfterCd = (
  segment: string,
  directory: string | null,
): string | null | undefined => {
  const tokens = (segment.match(TOKEN_PATTERN) ?? []).map(unquote);
  if (tokens[0] !== "cd") return undefined;

  const target = tokens[1];
  if (!target || target.startsWith("$") || target.startsWith("~")) return null;
  if (target === "-") return null;
  return resolveIn(directory, target);
};

export const readPathsFromBashCommand = (command: string): string[] => {
  const paths = new Set<string>();
  let directory: string | null = "";
  for (const segment of command.split(COMMAND_SEGMENT_SPLIT)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const cdDirectory = directoryAfterCd(trimmed, directory);
    if (cdDirectory !== undefined) {
      directory = cdDirectory;
      continue;
    }

    if (trimmed.includes(">")) continue;
    for (const resolved of pathsFromSegment(trimmed, directory)) {
      paths.add(resolved);
    }
  }
  return [...paths];
};
