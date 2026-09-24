/**
 * printable-input — 把一次终端输入翻译成「应进文本框的文本」（纯函数，无 IO）。
 *
 * 为什么要单独一层：pi 会在支持的终端上启用 Kitty 键盘协议（Ghostty / kitty /
 * wezterm…），此时**带修饰键的可打印键不再是原字符**，而是 CSI-u 编码：
 *   shift+b → `CSI 98:66;2u`（98=b，66=B，修饰位 2=shift）
 *   shift+; → `CSI 59:58;2u`
 * 不支持 Kitty 的终端则由 pi 退回 xterm modifyOtherKeys：
 *   shift+b → `CSI 27;2;66~`
 * 裸文本比较（`data === "b"`）和「长度 1 且 charCode>=32」这类启发式都会把
 * 这些按键当控制序列丢掉 —— 表现就是「大写 / 带 shift 的字符打不进去」。
 *
 * 规则（与 pi 自带 editor 的处理保持一致）：
 * - CSI-u / modifyOtherKeys 可打印键 → 解出字符（只认 shift，ctrl/alt/super 是快捷键）；
 * - bracketed paste（`\x1b[200~…\x1b[201~`）→ 剥包裹，控制字符丢掉（过滤框是单行）；
 * - 其余「首字符不是控制字符」的输入 → 原样当文本（ASCII / 中文 / IME 提交）。
 */

import { decodeKittyPrintable } from "@earendil-works/pi-tui";

/** bracketed paste 包裹：pi 把粘贴内容重新包成 `\x1b[200~…\x1b[201~`。 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// biome-ignore lint/suspicious/noControlCharactersInRegex: 终端转义序列本来就以 ESC 开头
const PASTE_MARKERS = /\x1b\[20[01]~/g;

/** xterm modifyOtherKeys：`CSI 27 ; modifier ; codepoint ~`。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 终端转义序列本来就以 ESC 开头
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;

/** xterm 修饰位：值从 1 起算，1=shift、2=alt、4=ctrl，64/128 是 Caps/Num Lock。 */
const XTERM_SHIFT = 1;
const XTERM_LOCK_MASK = 64 + 128;

const decodeModifyOtherKeys = (data: string): string | undefined => {
  const match = data.match(MODIFY_OTHER_KEYS);
  if (!match) return undefined;
  const modifier = (Number(match[1]) - 1) & ~XTERM_LOCK_MASK;
  if ((modifier & ~XTERM_SHIFT) !== 0) return undefined;
  const codepoint = Number(match[2]);
  if (!Number.isFinite(codepoint) || codepoint < 32) return undefined;
  return String.fromCodePoint(codepoint);
};

/** 返回应追加到查询框的文本；不是文本（控制序列 / 空输入）返回 undefined。 */
export const printableInput = (data: string): string | undefined => {
  const decoded = decodeKittyPrintable(data) ?? decodeModifyOtherKeys(data);
  if (decoded !== undefined) return decoded;

  if (data.includes(PASTE_START) || data.includes(PASTE_END)) {
    const clean = data.replace(PASTE_MARKERS, "").replace(/\p{Cc}/gu, "");
    return clean.length > 0 ? clean : undefined;
  }

  if (data.length === 0) return undefined;
  // 首字符是控制字符（含 0x7F DEL）⇒ 方向键 / 功能键 / ctrl 组合 / 裸 esc，不是文本。
  return /^\p{Cc}/u.test(data) ? undefined : data;
};
