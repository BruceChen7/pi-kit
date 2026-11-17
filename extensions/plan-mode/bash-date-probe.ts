const TOKEN_PATTERN = /'[^']*'|"[^"]*"|\S+/g;
const SHELL_METACHARACTERS = /[;&|><`$\n\\()]/;

const stripQuotes = (token: string): string =>
  token.replace(/^(["'])(.*)\1$/, "$2");

const isSetOrFileFlag = (token: string): boolean =>
  /^--set(=|$)/.test(token) || /^-[^-]*s/.test(token);

const isFlagOrFormat = (token: string): boolean =>
  token === "--" || token.startsWith("-") || token.startsWith("+");

export const isReadOnlyDateProbe = (command: string): boolean => {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (SHELL_METACHARACTERS.test(trimmed)) return false;

  const tokens = (trimmed.match(TOKEN_PATTERN) ?? []).map(stripQuotes);
  if (tokens[0] !== "date") return false;

  return tokens
    .slice(1)
    .every((token) => !isSetOrFileFlag(token) && isFlagOrFormat(token));
};
