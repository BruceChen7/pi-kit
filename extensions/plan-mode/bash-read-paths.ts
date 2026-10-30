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
/** Loop keywords that precede the command inside a segment: `do cat "$f"`. */
const LOOP_KEYWORDS = new Set(["do", "then", "else"]);
/**
 * `for f in a b; do` — the header is the only place a loop variable's value is
 * written out literally. `$(ls)` and `*.md` headers stay unresolved.
 */
const FOR_HEADER =
  /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;]*?)\s*;?\s*\bdo\b/g;
/** Cap on the variants one segment may fan out to. */
const LOOP_VAR_LIMIT = 8;

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
  const command = tokens[commandIndex(tokens)];
  if (!command || !READ_CONTENT_COMMANDS.has(command)) return [];

  const args = tokens.slice(commandIndex(tokens) + 1).map(unquote);
  if (args.some((token) => isInPlaceFlag(command, token))) return [];

  return args
    .filter(isPathShaped)
    .map((token) => resolveIn(directory, token))
    .filter((resolved): resolved is string => resolved !== null);
};

/**
 * Index of the command word: past env assignments and past a loop keyword, so
 * `do cat "$f"` reads the same as `cat "$f"`.
 */
const commandIndex = (tokens: string[]): number => {
  let index = 0;
  while (
    index < tokens.length &&
    (ASSIGNMENT_PATTERN.test(tokens[index]) || LOOP_KEYWORDS.has(tokens[index]))
  )
    index++;
  return index;
};

/** Directory a `cd` segment moves into, or undefined when it is not a `cd`. */
const directoryAfterCd = (
  segment: string,
  directory: string | null,
): string | null | undefined => {
  const tokens = (segment.match(TOKEN_PATTERN) ?? []).map(unquote);
  if (tokens[commandIndex(tokens)] !== "cd") return undefined;

  const target = tokens[commandIndex(tokens) + 1];
  if (!target || target.startsWith("$") || target.startsWith("~")) return null;
  if (target === "-") return null;
  return resolveIn(directory, target);
};

/**
 * Loop variables whose header lists literal values: `for f in a.md b.md; do`.
 * Values the shell computes (`$(ls)`, `*.md`, `$OTHER`) are dropped, so a
 * variable with an empty value list stays unresolved.
 */
const loopHeaderLiterals = (command: string): Map<string, string[]> => {
  const vars = new Map<string, string[]>();
  for (const match of command.matchAll(FOR_HEADER)) {
    const name = match[1];
    const values = (match[2].match(TOKEN_PATTERN) ?? [])
      .map(unquote)
      .filter(isPathShaped);
    if (values.length > 0) vars.set(name, values);
  }
  return vars;
};

/**
 * Every way one segment reads after a literal loop header is substituted in.
 * Returns the segment unchanged when it mentions no known loop variable, and
 * no variants when the fan-out would exceed the cap.
 */
const expandLoopVars = (
  segment: string,
  vars: Map<string, string[]>,
): string[] => {
  let variants = [segment];
  for (const [name, values] of vars) {
    if (!segment.includes(`$${name}`) && !segment.includes(`\${${name}}`)) {
      continue;
    }
    const pattern = new RegExp(`\\$(?:\\{${name}\\}|${name}\\b)`, "g");
    variants = variants.flatMap((variant) =>
      values.map((value) => variant.replace(pattern, value)),
    );
    if (variants.length > LOOP_VAR_LIMIT) return [];
  }
  return variants;
};

export const readPathsFromBashCommand = (command: string): string[] => {
  const paths = new Set<string>();
  const loopVars = loopHeaderLiterals(command);
  let directory: string | null = "";
  for (const segment of command.split(COMMAND_SEGMENT_SPLIT)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const variants = expandLoopVars(trimmed, loopVars);
    const cdDirectories = variants
      .map((variant) => directoryAfterCd(variant, directory))
      .filter((resolved): resolved is string | null => resolved !== undefined);
    if (cdDirectories.length > 0) {
      // One `cd` is trackable; a `cd` that fans out to several directories is
      // not, and guessing one of them would register reads that never happened.
      const distinct = new Set(cdDirectories);
      directory = distinct.size === 1 ? (cdDirectories[0] ?? null) : null;
      continue;
    }

    if (trimmed.includes(">")) continue;
    for (const variant of variants) {
      for (const resolved of pathsFromSegment(variant, directory)) {
        paths.add(resolved);
      }
    }
  }
  return [...paths];
};
