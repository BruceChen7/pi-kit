import fs from "node:fs";
import path from "node:path";

export type TelegramPollPaths = {
  lockPath: string;
  offsetPath: string;
  pendingPath: string;
};

export type TelegramMatch =
  | {
      type: "callback";
      data: string;
      update: Record<string, unknown>;
    }
  | {
      type: "text";
      text: string;
      update: Record<string, unknown>;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toMessageIds = (value: Iterable<number>): Set<number> => new Set(value);

const archiveCorruptFile = (filePath: string): void => {
  try {
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch {
    // best effort only
  }
};

export const createTelegramPollPaths = (
  baseDir: string,
): TelegramPollPaths => ({
  lockPath: path.join(baseDir, "poll.lock"),
  offsetPath: path.join(baseDir, "offset"),
  pendingPath: path.join(baseDir, "pending.json"),
});

const savePendingState = (
  paths: TelegramPollPaths,
  pending: Array<Record<string, unknown>>,
): void => {
  fs.mkdirSync(path.dirname(paths.pendingPath), { recursive: true });
  fs.writeFileSync(paths.pendingPath, `${JSON.stringify(pending)}\n`, "utf-8");
};

const loadOffset = (paths: TelegramPollPaths): number => {
  try {
    if (!fs.existsSync(paths.offsetPath)) {
      return 0;
    }
    const raw = fs.readFileSync(paths.offsetPath, "utf-8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      archiveCorruptFile(paths.offsetPath);
      return 0;
    }
    return parsed;
  } catch {
    archiveCorruptFile(paths.offsetPath);
    return 0;
  }
};

const saveOffset = (paths: TelegramPollPaths, offset: number): void => {
  fs.mkdirSync(path.dirname(paths.offsetPath), { recursive: true });
  fs.writeFileSync(paths.offsetPath, `${offset}\n`, "utf-8");
};

export const loadPendingState = (
  paths: TelegramPollPaths,
): Array<Record<string, unknown>> => {
  try {
    if (!fs.existsSync(paths.pendingPath)) {
      return [];
    }
    const parsed = JSON.parse(
      fs.readFileSync(paths.pendingPath, "utf-8"),
    ) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => !isRecord(entry))) {
      archiveCorruptFile(paths.pendingPath);
      return [];
    }
    return parsed;
  } catch {
    archiveCorruptFile(paths.pendingPath);
    return [];
  }
};

const getNestedRecord = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null => {
  const nested = value[key];
  return isRecord(nested) ? nested : null;
};

const getMessageId = (
  message: Record<string, unknown> | null,
): number | null => {
  if (!message) {
    return null;
  }
  const messageId = message.message_id;
  return typeof messageId === "number" ? messageId : null;
};

const getChatId = (message: Record<string, unknown> | null): string | null => {
  if (!message) {
    return null;
  }
  const chat = getNestedRecord(message, "chat");
  const chatId = chat?.id;
  if (typeof chatId === "string") {
    return chatId;
  }
  if (typeof chatId === "number") {
    return String(chatId);
  }
  return null;
};

const getText = (message: Record<string, unknown> | null): string | null => {
  if (!message) {
    return null;
  }
  const text = message.text;
  return typeof text === "string" && text.trim().length > 0
    ? text.trim()
    : null;
};

export const extractMatchingUpdate = (
  pending: Array<Record<string, unknown>>,
  acceptedMessageIds: Iterable<number>,
  acceptedChatId: string,
): {
  match: TelegramMatch | null;
  remaining: Array<Record<string, unknown>>;
} => {
  const messageIds = toMessageIds(acceptedMessageIds);

  for (let i = 0; i < pending.length; i++) {
    const update = pending[i];
    const callbackQuery = getNestedRecord(update, "callback_query");
    const message = getNestedRecord(callbackQuery ?? {}, "message");
    const messageId = getMessageId(message);
    if (callbackQuery && messageId !== null && messageIds.has(messageId)) {
      const data = callbackQuery.data;
      return {
        match: {
          type: "callback",
          data: typeof data === "string" ? data : "",
          update,
        },
        remaining: pending.filter((_, index) => index !== i),
      };
    }
  }

  for (let i = 0; i < pending.length; i++) {
    const update = pending[i];
    const message = getNestedRecord(update, "message");
    const replyToMessage = getNestedRecord(message ?? {}, "reply_to_message");
    const replyToMessageId = getMessageId(replyToMessage);
    const chatId = getChatId(message);
    const text = getText(message);
    if (
      message &&
      text &&
      chatId === acceptedChatId &&
      replyToMessageId !== null &&
      messageIds.has(replyToMessageId)
    ) {
      return {
        match: {
          type: "text",
          text,
          update,
        },
        remaining: pending.filter((_, index) => index !== i),
      };
    }
  }

  return { match: null, remaining: [...pending] };
};

const delay = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const DEFAULT_LOCK_STALE_MS = 30_000;

const removeStaleLock = (
  lockPath: string,
  now: () => number,
  staleMs: number,
): void => {
  try {
    const stats = fs.statSync(lockPath);
    if (now() - stats.mtimeMs >= staleMs) {
      fs.unlinkSync(lockPath);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
};

const acquireLock = async (
  lockPath: string,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  staleMs = DEFAULT_LOCK_STALE_MS,
): Promise<number> => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      removeStaleLock(lockPath, now, staleMs);
      await sleep(10);
    }
  }
};

const releaseLock = (lockPath: string, fd: number): void => {
  try {
    fs.closeSync(fd);
  } catch {
    // ignore close errors
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // ignore unlink errors
  }
};

const getUpdateId = (update: Record<string, unknown>): number | null => {
  const updateId = update.update_id;
  return typeof updateId === "number" ? updateId : null;
};

const pruneExpired = (
  pending: Array<Record<string, unknown>>,
  now: number,
  ttlMs: number,
): Array<Record<string, unknown>> =>
  pending.filter((update) => {
    const ts = update._ts;
    return typeof ts === "number" ? now - ts < ttlMs : true;
  });

export const pollTelegramUpdates = async (input: {
  paths: TelegramPollPaths;
  acceptedMessageIds: Iterable<number>;
  acceptedChatId: string;
  ttlMs: number;
  requestUpdates: (offset: number) => Promise<Array<Record<string, unknown>>>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  lockStaleMs?: number;
}): Promise<TelegramMatch | null> => {
  const sleep = input.sleep ?? delay;
  const now = input.now ?? Date.now;
  const fd = await acquireLock(
    input.paths.lockPath,
    sleep,
    now,
    input.lockStaleMs,
  );

  try {
    const currentTime = now();
    const pending = pruneExpired(
      loadPendingState(input.paths),
      currentTime,
      input.ttlMs,
    );
    const pendingMatch = extractMatchingUpdate(
      pending,
      input.acceptedMessageIds,
      input.acceptedChatId,
    );
    if (pendingMatch.match) {
      savePendingState(input.paths, pendingMatch.remaining);
      return pendingMatch.match;
    }

    const fetched = await input.requestUpdates(loadOffset(input.paths));
    let nextOffset = loadOffset(input.paths);
    let match: TelegramMatch | null = null;
    const unmatched: Array<Record<string, unknown>> = [];

    for (const update of fetched) {
      const updateId = getUpdateId(update);
      if (updateId !== null) {
        nextOffset = Math.max(nextOffset, updateId + 1);
      }

      const stamped = {
        ...update,
        _ts: currentTime,
      };
      if (match) {
        unmatched.push(stamped);
        continue;
      }

      const extracted = extractMatchingUpdate(
        [stamped],
        input.acceptedMessageIds,
        input.acceptedChatId,
      );
      if (extracted.match) {
        match = extracted.match;
        continue;
      }
      unmatched.push(stamped);
    }

    saveOffset(input.paths, nextOffset);
    savePendingState(input.paths, [...pendingMatch.remaining, ...unmatched]);
    return match;
  } finally {
    releaseLock(input.paths.lockPath, fd);
  }
};
