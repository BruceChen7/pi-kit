import fs from "node:fs";
import path from "node:path";

export type SessionRegistryCardEntry = {
  chatJid: string;
  worktreePath: string;
  lastActiveAt: string;
};

export type SessionRegistry = {
  schemaVersion: 1;
  cards: Record<string, SessionRegistryCardEntry>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildEmptyRegistry(): SessionRegistry {
  return {
    schemaVersion: 1,
    cards: {},
  };
}

export function readSessionRegistry(registryPath: string): SessionRegistry {
  if (!fs.existsSync(registryPath)) {
    return buildEmptyRegistry();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as unknown;
  } catch {
    return buildEmptyRegistry();
  }

  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !isRecord(parsed.cards)
  ) {
    return buildEmptyRegistry();
  }

  const cards: Record<string, SessionRegistryCardEntry> = {};
  for (const [cardId, raw] of Object.entries(parsed.cards)) {
    if (!isRecord(raw)) continue;
    const chatJid = trimToNull(raw.chatJid);
    const worktreePath = trimToNull(raw.worktreePath);
    const lastActiveAt = trimToNull(raw.lastActiveAt);
    if (!chatJid || !worktreePath || !lastActiveAt) continue;

    cards[cardId] = {
      chatJid,
      worktreePath,
      lastActiveAt,
    };
  }

  return {
    schemaVersion: 1,
    cards,
  };
}

export function writeSessionRegistry(
  registryPath: string,
  registry: SessionRegistry,
): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8",
  );
}

export function upsertSessionRegistryCard(
  registryPath: string,
  input: {
    cardId: string;
    chatJid: string;
    worktreePath: string;
    nowIso: string;
  },
): SessionRegistry {
  const registry = readSessionRegistry(registryPath);
  registry.cards[input.cardId] = {
    chatJid: input.chatJid,
    worktreePath: input.worktreePath,
    lastActiveAt: input.nowIso,
  };
  writeSessionRegistry(registryPath, registry);
  return registry;
}
