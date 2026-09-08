// biome-ignore-all lint/style/noNonNullAssertion: tests use ! for brevity
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEntry, type QueryLogEntry } from "./core.ts";
import {
  appendEntry,
  incrementRepeat,
  loadRecentEntries,
  monthFile,
  parseLine,
  resolveLogDir,
} from "./store.ts";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../shared/logger.ts", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => loggerMocks.warn(...args),
    error: vi.fn(),
  })),
}));

let tmpDir: string;

beforeEach(async () => {
  loggerMocks.warn.mockClear();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qnl-store-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveLogDir / monthFile", () => {
  it("resolveLogDir points under homedir/.pi/agent/query-notes-log", () => {
    expect(resolveLogDir()).toBe(
      path.join(os.homedir(), ".pi", "agent", "query-notes-log"),
    );
  });

  it("monthFile names files YYYY-MM.jsonl in local timezone", () => {
    const d = new Date(2026, 8, 8, 10, 30); // 2026-09-08
    expect(monthFile(tmpDir, d)).toBe(path.join(tmpDir, "2026-09.jsonl"));
    const d2 = new Date(2026, 11, 1);
    expect(monthFile(tmpDir, d2)).toBe(path.join(tmpDir, "2026-12.jsonl"));
  });
});

describe("parseLine", () => {
  it("parses a valid entry line", () => {
    const line = JSON.stringify({
      id: "1-a1",
      ts: 1757328000000,
      q: "malloc 怎么实现",
      repeats: 2,
    });
    expect(parseLine(line)).toEqual({
      id: "1-a1",
      ts: 1757328000000,
      q: "malloc 怎么实现",
      repeats: 2,
    });
  });

  it("returns null for invalid JSON and wrong shape", () => {
    expect(parseLine("not json")).toBeNull();
    expect(parseLine('{"id":1}')).toBeNull();
    expect(parseLine('{"id":"x","ts":1,"q":"q"}')).toBeNull(); // missing repeats
  });
});

describe("appendEntry", () => {
  it("creates the directory and appends a line", async () => {
    const entry = makeEntry(
      "malloc 怎么实现",
      Date.parse("2026-09-08T10:30:00"),
    );
    await appendEntry(tmpDir, entry);

    const content = await fs.readFile(
      path.join(tmpDir, "2026-09.jsonl"),
      "utf-8",
    );
    expect(content.trim()).toBe(JSON.stringify(entry));
  });

  it("appends multiple entries without overwriting", async () => {
    const e1 = makeEntry("q1", Date.parse("2026-09-01T00:00:00"));
    const e2 = makeEntry("q2", Date.parse("2026-09-02T00:00:00"));
    await appendEntry(tmpDir, e1);
    await appendEntry(tmpDir, e2);

    const lines = (
      await fs.readFile(path.join(tmpDir, "2026-09.jsonl"), "utf-8")
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).q).toBe("q1");
    expect(JSON.parse(lines[1]).q).toBe("q2");
  });
});

describe("loadRecentEntries", () => {
  it("returns [] when the directory does not exist", async () => {
    expect(await loadRecentEntries(tmpDir, 10)).toEqual([]);
  });

  it("loads entries across months, newest first, capped at n", async () => {
    const augEntry = makeEntry("aug q", Date.parse("2026-08-20T00:00:00"));
    const sepEntries = [
      makeEntry("sep1", Date.parse("2026-09-01T00:00:00")),
      makeEntry("sep2", Date.parse("2026-09-10T00:00:00")),
    ];
    await appendEntry(tmpDir, augEntry);
    await appendEntry(tmpDir, sepEntries[0]);
    await appendEntry(tmpDir, sepEntries[1]);

    const entries = await loadRecentEntries(tmpDir, 10);
    expect(entries.map((e) => e.q)).toEqual(["sep2", "sep1", "aug q"]);

    const capped = await loadRecentEntries(tmpDir, 2);
    expect(capped.map((e) => e.q)).toEqual(["sep2", "sep1"]);
  });

  it("skips bad lines with a warning instead of crashing", async () => {
    const entry = makeEntry("good q", Date.parse("2026-09-01T00:00:00"));
    await appendEntry(tmpDir, entry);
    const file = path.join(tmpDir, "2026-09.jsonl");
    await fs.appendFile(file, "this is not json\n", "utf-8");

    const entries = await loadRecentEntries(tmpDir, 10);
    expect(entries.map((e) => e.q)).toEqual(["good q"]);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ file }),
    );
  });
});

describe("incrementRepeat", () => {
  it("increments repeats on the matching entry and rewrites the file", async () => {
    const entry = makeEntry(
      "malloc 怎么实现",
      Date.parse("2026-09-01T00:00:00"),
    );
    const other = makeEntry("eBPF 观测", Date.parse("2026-09-02T00:00:00"));
    await appendEntry(tmpDir, entry);
    await appendEntry(tmpDir, other);

    await incrementRepeat(tmpDir, entry);

    const lines = (
      await fs.readFile(path.join(tmpDir, "2026-09.jsonl"), "utf-8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as QueryLogEntry);
    const byId = new Map(lines.map((e) => [e.id, e]));
    expect(byId.get(entry.id)!.repeats).toBe(2);
    expect(byId.get(other.id)!.repeats).toBe(1);
  });

  it("does nothing when the entry is not in the file", async () => {
    const existing = makeEntry("q", Date.parse("2026-09-01T00:00:00"));
    await appendEntry(tmpDir, existing);
    const missing = makeEntry("missing", Date.parse("2026-09-01T00:00:00"));

    await incrementRepeat(tmpDir, missing);

    const lines = (
      await fs.readFile(path.join(tmpDir, "2026-09.jsonl"), "utf-8")
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).q).toBe("q");
  });

  it("does nothing when the target month file does not exist", async () => {
    await incrementRepeat(
      tmpDir,
      makeEntry("q", Date.parse("2026-08-01T00:00:00")),
    );
    expect(await loadRecentEntries(tmpDir, 10)).toEqual([]);
  });
});
