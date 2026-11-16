/**
 * Is a shell command a read-only clock probe?
 *
 * Plan artifacts are named `YYYY-MM-DD-<slug>.md` against the **host's local**
 * calendar, and the model has no reliable "today" in context: it guesses from
 * the most recent date it saw and names the file with yesterday's date. The
 * fix is to have it read the clock with `date` before naming the file.
 *
 * Plan phase otherwise blocks `bash` (read-only inspection is `read`/`ls`/
 * `grep`/`find`, none of which can print the date), so that probe needs a
 * narrow allowance. Value in / value out, no side effects: this only decides
 * whether the command is a bare, non-mutating `date` invocation.
 *
 * Deliberately strict — a bare `date` with format/flags only, and no shell
 * metacharacters that could chain a second command, redirect, or substitute:
 * `date && rm -rf x`, `date; …`, `$(…)`, backticks and `>` are all rejected,
 * and so is the clock-setting flag (`date -s`, `date --set`).
 */

/** Quote-aware tokenizer: `date "+%Y-%m-%d %H:%M"` is two tokens. */
const TOKEN_PATTERN = /'[^']*'|"[^"]*"|\S+/g;

/** Chaining, redirection, substitution, grouping — never a bare clock read. */
const SHELL_METACHARACTERS = /[;&|><`$\n\\()]/;

const stripQuotes = (token: string): string =>
  token.replace(/^(["'])(.*)\1$/, "$2");

/** Flags that mutate the clock or read a file: not a read-only probe. */
const isMutatingFlag = (token: string): boolean =>
  /^--set(=|$)/.test(token) || /^-[^-]*s/.test(token);

/** Format strings (`+%F`, `"+%Y-%m-%d"`), the `--` separator, and short flags. */
const isAllowedArg = (token: string): boolean =>
  token === "--" || token.startsWith("-") || token.startsWith("+");

export const isReadOnlyDateProbe = (command: string): boolean => {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (SHELL_METACHARACTERS.test(trimmed)) return false;

  const tokens = (trimmed.match(TOKEN_PATTERN) ?? []).map(stripQuotes);
  if (tokens[0] !== "date") return false;

  return tokens.slice(1).every((token) => {
    if (isMutatingFlag(token)) return false;
    return isAllowedArg(token);
  });
};
