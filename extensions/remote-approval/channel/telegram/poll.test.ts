import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTelegramPollPaths,
  extractMatchingUpdate,
  loadPendingState,
  pollTelegramUpdates,
} from "./poll.ts";

const tempDirs: string[] = [];

const createTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("remote-approval telegram poll", () => {
  it("extracts callback updates by accepted message ids", () => {
    const pending = [
      {
        update_id: 1,
        callback_query: {
          id: "cb-1",
          data: "allow",
          message: { message_id: 42 },
        },
      },
      {
        update_id: 2,
        callback_query: {
          id: "cb-2",
          data: "deny",
          message: { message_id: 99 },
        },
      },
    ];

    const result = extractMatchingUpdate(pending, [42], "1234");

    expect(result.match).toMatchObject({
      type: "callback",
      data: "allow",
    });
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0]).toMatchObject({ update_id: 2 });
  });

  it("extracts text replies only when reply_to matches an accepted message id", () => {
    const pending = [
      {
        update_id: 1,
        message: {
          text: "wrong",
          chat: { id: "1234" },
          reply_to_message: { message_id: 9 },
        },
      },
      {
        update_id: 2,
        message: {
          text: "next instruction",
          chat: { id: "1234" },
          reply_to_message: { message_id: 77 },
        },
      },
    ];

    const result = extractMatchingUpdate(pending, [77], "1234");

    expect(result.match).toMatchObject({
      type: "text",
      text: "next instruction",
    });
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0]).toMatchObject({ update_id: 1 });
  });

  it("archives corrupt pending state and returns an empty queue", () => {
    const dir = createTempDir("pi-kit-remote-approval-poll-");
    const paths = createTelegramPollPaths(dir);

    fs.mkdirSync(path.dirname(paths.pendingPath), { recursive: true });
    fs.writeFileSync(paths.pendingPath, "{bad-json}", "utf-8");

    const pending = loadPendingState(paths);

    expect(pending).toEqual([]);
    const archived = fs
      .readdirSync(path.dirname(paths.pendingPath))
      .filter((entry) => entry.startsWith("pending.json.corrupt-"));
    expect(archived.length).toBe(1);
  });

  it("polls fresh telegram updates, returns the matching callback, and stores non-matching updates in pending state", async () => {
    const dir = createTempDir("pi-kit-remote-approval-poll-");
    const paths = createTelegramPollPaths(dir);

    const match = await pollTelegramUpdates({
      paths,
      acceptedMessageIds: [77],
      acceptedChatId: "1234",
      ttlMs: 60_000,
      requestUpdates: async (offset) => {
        expect(offset).toBe(0);
        return [
          {
            update_id: 1,
            callback_query: {
              id: "cb-1",
              data: "idle:dismiss",
              message: { message_id: 77 },
            },
          },
          {
            update_id: 2,
            message: {
              text: "keep for someone else",
              chat: { id: "1234" },
              reply_to_message: { message_id: 88 },
            },
          },
        ];
      },
      sleep: async () => undefined,
      now: () => 1_000,
    });

    expect(match).toMatchObject({
      type: "callback",
      data: "idle:dismiss",
    });
    expect(loadPendingState(paths)).toMatchObject([
      {
        update_id: 2,
      },
    ]);
    expect(fs.readFileSync(paths.offsetPath, "utf-8").trim()).toBe("3");
  });
});
