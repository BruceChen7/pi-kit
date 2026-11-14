/**
 * Shell text helpers shared by the command-scanning extensions.
 *
 * `stripHeredocBodies` exists so a script *written* by a command is not read as
 * the command itself: `cat >> f <<'EOF'` followed by prose that mentions a
 * destructive verb is a write, not a deletion.
 */

const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

export const stripHeredocBodies = (command: string): string => {
  const lines = command.split("\n");
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    kept.push(line);
    const start = HEREDOC_START.exec(line);
    if (!start) {
      continue;
    }
    const delimiter = start[2] ?? "";
    let end = index + 1;
    while (end < lines.length && (lines[end] ?? "").trim() !== delimiter) {
      end += 1;
    }
    index = end;
  }

  return kept.join("\n");
};
