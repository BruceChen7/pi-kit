/**
 * 共享 shell 结构层（ADR-0001 D3）。护栏不再各写一份"剥引号 / 跳 heredoc"的
 * 扫描器，而是查询同一份结构：
 *
 * - `analyzeShell(source)` 拿到命令段、重定向、结构关键字、嵌套脚本与
 *   `unresolved`（判定不了的动态执行）。
 * - 判断不了的动态执行不静默放行，由护栏决定拒绝还是保守放行。
 */

export * from "./analyze.ts";
export * from "./tokenize.ts";
