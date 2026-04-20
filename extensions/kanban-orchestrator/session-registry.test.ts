import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSessionRegistry,
  upsertSessionRegistryCard,
} from "./session-registry.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-orchestrator-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("session registry", () => {
  it("returns an empty registry when file is missing", () => {
    const dir = createTempDir();
    const registryPath = path.join(dir, "session-registry.json");

    expect(readSessionRegistry(registryPath)).toEqual({
      schemaVersion: 1,
      cards: {},
    });
  });

  it("upserts card session metadata and persists it", () => {
    const dir = createTempDir();
    const registryPath = path.join(dir, "session-registry.json");

    upsertSessionRegistryCard(registryPath, {
      cardId: "feat-checkout-v2",
      chatJid: "chat:feat-checkout-v2",
      worktreePath: "/tmp/wt/main--feat-checkout-v2",
      nowIso: "2026-04-20T00:00:00.000Z",
    });

    expect(readSessionRegistry(registryPath)).toEqual({
      schemaVersion: 1,
      cards: {
        "feat-checkout-v2": {
          chatJid: "chat:feat-checkout-v2",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          lastActiveAt: "2026-04-20T00:00:00.000Z",
        },
      },
    });
  });
});
