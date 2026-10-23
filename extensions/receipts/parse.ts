/**
 * 测试收据的纯函数部分：认出测试命令、从输出里取计数、从提交消息里取断言、
 * 判断断言能否对上收据。读写文件与拦截工具调用在 store.ts / index.ts。
 *
 * 设计取舍：断言只认三种明确写法，宁可漏拦也不误拦。没有断言就没有可核验的
 * 声明，拦它只会制造摩擦。
 */

export type TestCounts = { passed: number; failed: number };

export type Receipt = {
  command: string;
  passed: number;
  failed: number;
  exitCode: number;
  at: string;
};

export type TestClaim = {
  /** 断言里说的 passed 数。 */
  count: number;
  /** 命中的原文，用于把理由写清楚。 */
  matched: string;
};

export type ReceiptVerdict = { ok: true } | { ok: false; reason: string };

const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bvitest\b/,
  /\bjest\b/,
  /\bnpm\s+(?:run\s+)?test\b/,
  /\bpnpm\s+(?:run\s+)?test\b/,
  /\byarn\s+test\b/,
  /\bmake\s+test\b/,
  /\bgo\s+test\b/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
];

export const classifyTestCommand = (command: string): boolean => {
  const text = String(command ?? "");
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
};

const lastNumber = (text: string, pattern: RegExp): number | null => {
  let value: number | null = null;
  for (const match of text.matchAll(pattern)) {
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed)) {
      value = parsed;
    }
  }
  return value;
};

/**
 * 只看 `N passed` / `N failed` 这两个词，覆盖 vitest、jest、pytest 的汇总行。
 * `go test` 不打印计数，所以取不到就返回 null，那条命令不记收据。
 */
export const parseTestCounts = (output: string): TestCounts | null => {
  const text = String(output ?? "");
  if (!/\bTests?\b|\bpassed\b/i.test(text)) {
    return null;
  }
  const passed = lastNumber(text, /(\d+)\s+passed\b/gi);
  if (passed === null) {
    return null;
  }
  const failed = lastNumber(text, /(\d+)\s+failed\b/gi) ?? 0;
  return { passed, failed };
};

const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bTests?:\s*(\d+)\b/i,
  /\b(\d+)\s+tests?\s+passed\b/i,
  /\b(\d+)\s+passed\b/i,
];

export const extractTestClaim = (text: string): TestClaim | null => {
  for (const pattern of CLAIM_PATTERNS) {
    const match = pattern.exec(String(text ?? ""));
    if (match?.[1]) {
      const count = Number(match[1]);
      if (Number.isInteger(count)) {
        return { count, matched: match[0].trim() };
      }
    }
  }
  return null;
};

const describeReceipt = (receipt: Receipt): string =>
  `\`${receipt.command}\` → ${receipt.passed} passed` +
  (receipt.failed > 0 ? `, ${receipt.failed} failed` : "");

/**
 * 断言必须能对上本会话某一次真实运行的 passed 数。
 * 没有收据就拦，并说明「先跑一次」；有收据但数字不符就拦，并给出实际数字。
 */
export const checkReceipts = (
  claim: TestClaim,
  receipts: readonly Receipt[],
): ReceiptVerdict => {
  if (receipts.length === 0) {
    return {
      ok: false,
      reason:
        `No test run recorded in this session, so "${claim.matched}" cannot be checked. ` +
        "Run the suite first, or drop the count from the message.",
    };
  }
  if (receipts.some((receipt) => receipt.passed === claim.count)) {
    return { ok: true };
  }
  const latest = receipts[receipts.length - 1] as Receipt;
  return {
    ok: false,
    reason:
      `"${claim.matched}" does not match any recorded run. ` +
      `Most recent: ${describeReceipt(latest)}.`,
  };
};

/** 只在这两条命令前判：提交与开 PR。别的命令不碰。 */
export const isPublishCommand = (command: string): boolean =>
  /\bgit\s+commit\b/.test(command) || /\bgh\s+pr\s+create\b/.test(command);

const FLAGS: Record<"commit" | "pr", readonly string[]> = {
  commit: ["-m", "--message"],
  pr: ["-b", "--body", "-t", "--title"],
};

/** 读一个 flag 后面的值，支持单/双引号与 `--flag=value`。 */
const readFlagValues = (text: string, flags: readonly string[]): string[] => {
  const values: string[] = [];
  for (const flag of flags) {
    const pattern = new RegExp(
      `${flag.replace(/[-]/g, "\\-")}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(\\S+))`,
      "g",
    );
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      if (value) {
        values.push(value);
      }
    }
  }
  return values;
};

/**
 * 从发布命令里取出会被写进历史的文本。取不到就返回 null，调用方不判。
 * `git commit -F file` 与 `gh pr create --body-file` 不读：那要看文件内容，
 * 属于下一层的事。
 */
export const extractPublishMessage = (command: string): string | null => {
  const text = String(command ?? "");
  const kind = /\bgh\s+pr\s+create\b/.test(text)
    ? "pr"
    : /\bgit\s+commit\b/.test(text)
      ? "commit"
      : null;
  if (!kind) {
    return null;
  }
  const values = readFlagValues(text, FLAGS[kind]);
  return values.length > 0 ? values.join("\n") : null;
};
