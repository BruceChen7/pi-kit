/**
 * Shell 文本辅助。实现挂在共享结构层上（ADR-0001 D3），这样"heredoc 正文
 * 不算命令"这件事只有一份判定，safe-delete 与 bash-block-guard 不会各写一遍。
 *
 * `stripHeredocBodies` 存在的理由：一条命令**写下去**的脚本不是它**执行**的
 * 脚本 —— `cat >> f <<'EOF'` 后面那些提到删除、sleep 的正文只是文本。
 */

import { tokenizeShell } from "./shell/index.ts";

export const stripHeredocBodies = (command: string): string => {
  const { tokens } = tokenizeShell(command);
  const spans = tokens.flatMap((token) =>
    token.kind === "heredoc"
      ? [{ start: token.bodyStart, end: token.bodyEnd }]
      : [],
  );
  if (spans.length === 0) {
    return command;
  }

  let stripped = "";
  let cursor = 0;
  for (const span of spans) {
    stripped += command.slice(cursor, span.start);
    cursor = span.end;
  }
  return stripped + command.slice(cursor);
};
