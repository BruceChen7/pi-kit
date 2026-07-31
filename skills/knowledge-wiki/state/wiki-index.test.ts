import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// wiki-index.mjs is a CLI shell whose import-time knowledge-dir resolution
// (lib/paths.mjs) exits the process when no knowledge base root is available.
// Inject a dummy --base-path into argv BEFORE importing so the module loads.
const BASE_DIR = join(tmpdir(), "wiki-index-test-base");
process.argv.push("--base-path", BASE_DIR);

const {
  resolveIndexTarget,
  shardIndexPath,
  listShardYears,
  partitionShardLines,
  upsertBullet,
  deleteBullet,
  renderIndexContent,
  renderShardContent,
} = await import("./wiki-index.mjs");

const CLI = new URL("./wiki-index.mjs", import.meta.url).pathname;

// ── helpers ─────────────────────────────────────────────

let kb: string;

beforeEach(() => {
  kb = mkdtempSync(join(tmpdir(), "wiki-index-kb-"));
});

afterEach(() => {
  rmSync(kb, { recursive: true, force: true });
});

/** Run the CLI against the temp knowledge base. */
function runCli(...args: string[]) {
  return execFileSync(process.execPath, [CLI, ...args, "--base-path", kb], {
    encoding: "utf8",
  });
}

function writeKb(relPath: string, content: string) {
  const full = join(kb, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function readKb(relPath: string) {
  return readFileSync(join(kb, relPath), "utf8");
}

/** Minimal main index fixture: Concepts + Summaries sections. */
const MAIN_INDEX = `# Knowledge Base Index

## Concepts

- [[Wiki/Concepts/redis|Redis]] — In-memory data store

## Summaries

- [[Wiki/Summaries/Notes/redis.summary]] — Redis note
`;

// ── Pure: resolveIndexTarget ────────────────────────────

describe("resolveIndexTarget", () => {
  it.each([
    // DailyNotes with a 4-digit year subdirectory → shard
    [
      "Calendar/DailyNotes/2026/2026-07-06.summary",
      { type: "shard", year: "2026" },
    ],
    [
      "Calendar/DailyNotes/2023/2023-01-01.summary",
      { type: "shard", year: "2023" },
    ],
    // Notes / concepts → main
    ["Notes/redis.summary", { type: "main" }],
    ["Notes/foo/bar.summary", { type: "main" }],
    // DailyNotes entry WITHOUT a year subdirectory → main (e.g. raindrop archive)
    ["Calendar/DailyNotes/raindrop-bookmarks-2026.summary", { type: "main" }],
    // Other calendars → main
    ["Calendar/Other/2026/x.summary", { type: "main" }],
  ])("%s → %j", (relPath, expected) => {
    expect(resolveIndexTarget(relPath)).toEqual(expected);
  });
});

describe("shardIndexPath", () => {
  it("builds the shard path under the given wiki dir", () => {
    const wiki = join(kb, "Wiki");
    expect(shardIndexPath("2026", wiki)).toBe(join(wiki, "index-2026.md"));
    // Default falls back to the module-resolved Wiki dir (no env coupling needed
    // when an explicit dir is passed).
    expect(shardIndexPath("2026")).toBe(
      join(BASE_DIR, "Wiki", "index-2026.md"),
    );
  });
});

describe("listShardYears", () => {
  it("returns existing shard years sorted ascending, ignoring other files", () => {
    const wiki = join(kb, "Wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "index-2026.md"), "# x\n");
    writeFileSync(join(wiki, "index-2023.md"), "# x\n");
    writeFileSync(join(wiki, "index.md"), "# x\n");
    writeFileSync(join(wiki, "index-abc.md"), "# x\n");

    expect(listShardYears(wiki)).toEqual(["2023", "2026"]);
  });
});

// ── Pure: partitionShardLines ───────────────────────────

describe("partitionShardLines", () => {
  it("buckets DailyNotes by year and keeps everything else in order", () => {
    const lines = [
      "- [[Wiki/Summaries/Calendar/DailyNotes/2023/2023-01-01.summary]] — A",
      "- [[Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary]] — B",
      "- [[Wiki/Summaries/Calendar/DailyNotes/raindrop-bookmarks-2026.summary]] — C",
      "- [[Wiki/Summaries/Notes/redis.summary]] — D",
    ];
    const { shards, kept } = partitionShardLines(lines);

    expect([...shards.keys()]).toEqual(["2023", "2026"]);
    expect(shards.get("2023")).toEqual([lines[0]]);
    expect(shards.get("2026")).toEqual([lines[1]]);
    expect(kept).toEqual([lines[2], lines[3]]);
  });

  it("returns empty shards and all lines as kept for non-DailyNotes input", () => {
    const lines = ["- [[Wiki/Summaries/Notes/redis.summary]] — D"];
    const { shards, kept } = partitionShardLines(lines);
    expect(shards.size).toBe(0);
    expect(kept).toEqual(lines);
  });

  it("treats malformed non-bullet lines as kept", () => {
    const lines = ["- [[Wiki/Summaries/Notes/a.summary]] — A", "not a bullet"];
    const { shards, kept } = partitionShardLines(lines);
    expect(shards.size).toBe(0);
    expect(kept).toEqual(lines);
  });
});

// ── Pure: upsertBullet / deleteBullet ───────────────────

describe("upsertBullet", () => {
  it("inserts when the rel-path is absent and updates when present", () => {
    const lines = ["- [[Wiki/Summaries/Notes/a.summary]] — A"];

    const inserted = upsertBullet(
      lines,
      "Notes/b.summary",
      "- [[Wiki/Summaries/Notes/b.summary]] — B",
    );
    expect(inserted.action).toBe("inserted");
    expect(inserted.lines).toHaveLength(2);
    expect(inserted.lines[1]).toContain("Notes/b.summary");
    // input is not mutated
    expect(lines).toHaveLength(1);

    const updated = upsertBullet(
      inserted.lines,
      "Notes/a.summary",
      "- [[Wiki/Summaries/Notes/a.summary]] — A2",
    );
    expect(updated.action).toBe("updated");
    expect(updated.lines).toHaveLength(2);
    expect(updated.lines[0]).toContain("A2");
  });
});

describe("deleteBullet", () => {
  it("removes the matching bullet and reports not-found otherwise", () => {
    const lines = ["- [[Wiki/Summaries/Notes/a.summary]] — A"];

    const hit = deleteBullet(lines, "Notes/a.summary");
    expect(hit.found).toBe(true);
    expect(hit.lines).toEqual([]);

    const miss = deleteBullet(lines, "Notes/nope.summary");
    expect(miss.found).toBe(false);
    expect(miss.lines).toBe(lines);
  });
});

// ── Pure: renderIndexContent / renderShardContent ───────

describe("renderIndexContent", () => {
  it("renders title, Archive, Concepts and Summaries with sorting", () => {
    const content = renderIndexContent(
      ["- [[Wiki/Concepts/b|B]] — b", "- [[Wiki/Concepts/a|A]] — a"],
      [
        "- [[Wiki/Summaries/Notes/z.summary]] — z",
        "- [[Wiki/Summaries/Notes/a.summary]] — a",
      ],
      ["2023", "2026"],
    );

    expect(content).toContain("# Knowledge Base Index");
    expect(content).toContain("## Archive");
    expect(content).toContain("- [[Wiki/index-2023|2023]]");
    expect(content.indexOf("## Concepts")).toBeLessThan(
      content.indexOf("## Summaries"),
    );
    expect(content.indexOf("Wiki/Concepts/a")).toBeLessThan(
      content.indexOf("Wiki/Concepts/b"),
    );
    expect(content.indexOf("Notes/a.summary")).toBeLessThan(
      content.indexOf("Notes/z.summary"),
    );
  });
});

describe("renderShardContent", () => {
  it("renders the shard title and sorted Summaries section", () => {
    const content = renderShardContent("2026", [
      "- [[Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary]] — B",
      "- [[Wiki/Summaries/Calendar/DailyNotes/2026/2026-01-01.summary]] — A",
    ]);

    expect(content).toContain("# Daily Notes Index 2026");
    expect(content.indexOf("2026-01-01")).toBeLessThan(
      content.indexOf("2026-07-06"),
    );
  });
});

// ── upsert-summary routing ──────────────────────────────

describe("upsert-summary", () => {
  it("routes DailyNotes entries into the year shard, adding only an Archive link to the main index", () => {
    writeKb(
      "Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary.md",
      "body",
    );
    writeKb("Wiki/index.md", MAIN_INDEX);

    runCli(
      "upsert-summary",
      "Calendar/DailyNotes/2026/2026-07-06.summary",
      "A daily note",
    );

    const shard = readKb("Wiki/index-2026.md");
    expect(shard).toContain("# Daily Notes Index 2026");
    expect(shard).toContain(
      "[[Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary]] — A daily note",
    );
    // The summary entry itself stays out of the main index…
    expect(readKb("Wiki/index.md")).not.toContain("2026-07-06");
    // …but the first upsert for the year links the new shard from Archive.
    expect(readKb("Wiki/index.md")).toContain("- [[Wiki/index-2026|2026]]");
  });

  it("adds an Archive link to the main index when the year shard is first created", () => {
    writeKb(
      "Wiki/Summaries/Calendar/DailyNotes/2027/2027-01-01.summary.md",
      "body",
    );
    writeKb("Wiki/index.md", MAIN_INDEX);

    runCli(
      "upsert-summary",
      "Calendar/DailyNotes/2027/2027-01-01.summary",
      "New year",
    );

    const main = readKb("Wiki/index.md");
    expect(main).toContain("## Archive");
    expect(main).toContain("- [[Wiki/index-2027|2027]]");
  });

  it("keeps a single Archive link when upserting into an existing shard", () => {
    writeKb(
      "Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary.md",
      "body",
    );
    writeKb("Wiki/index.md", MAIN_INDEX);

    runCli(
      "upsert-summary",
      "Calendar/DailyNotes/2026/2026-07-06.summary",
      "V1",
    );
    runCli(
      "upsert-summary",
      "Calendar/DailyNotes/2026/2026-07-06.summary",
      "V2",
    );

    // Second upsert targets an existing shard — the main index is not
    // rewritten, so the Archive link stays exactly once.
    expect(readKb("Wiki/index.md").match(/index-2026/g)).toHaveLength(1);
  });

  it("updates an existing shard entry instead of duplicating it", () => {
    writeKb(
      "Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary.md",
      "body",
    );
    writeKb("Wiki/index.md", MAIN_INDEX);

    runCli(
      "upsert-summary",
      "Calendar/DailyNotes/2026/2026-07-06.summary",
      "V1",
    );
    runCli(
      "upsert-summary",
      "Calendar/DailyNotes/2026/2026-07-06.summary",
      "V2",
    );

    const shard = readKb("Wiki/index-2026.md");
    expect(shard.match(/V2/g)).toHaveLength(1);
    expect(shard).not.toContain("V1");
  });

  it("routes Notes entries into the main index", () => {
    writeKb("Wiki/Summaries/Notes/redis.summary.md", "body");
    writeKb("Wiki/index.md", MAIN_INDEX);

    runCli("upsert-summary", "Notes/redis.summary", "Redis note updated");

    expect(readKb("Wiki/index.md")).toContain(
      "[[Wiki/Summaries/Notes/redis.summary]] — Redis note updated",
    );
    expect(readKb("Wiki/index.md")).not.toContain("Redis note\n");
  });
});

// ── split-daily-shards migration ────────────────────────

describe("split-daily-shards", () => {
  const SUMMARIES = [
    ["Wiki/Summaries/Calendar/DailyNotes/2023/2023-01-01.summary.md", "body"],
    ["Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary.md", "body"],
    [
      "Wiki/Summaries/Calendar/DailyNotes/raindrop-bookmarks-2026.summary.md",
      "body",
    ],
    ["Wiki/Summaries/Notes/redis.summary.md", "body"],
  ];

  const MIXED_INDEX = `# Knowledge Base Index

## Concepts

- [[Wiki/Concepts/redis|Redis]] — In-memory data store

## Summaries

- [[Wiki/Summaries/Calendar/DailyNotes/2023/2023-01-01.summary]] — Day one
- [[Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary]] — Today
- [[Wiki/Summaries/Calendar/DailyNotes/raindrop-bookmarks-2026.summary]] — Bookmarks
- [[Wiki/Summaries/Notes/redis.summary]] — Redis note
`;

  function buildMigratedKb() {
    for (const [rel, content] of SUMMARIES) writeKb(rel, content);
    writeKb("Wiki/index.md", MIXED_INDEX);
  }

  it("splits DailyNotes into year shards, keeps Notes in the main index, and backs up", () => {
    buildMigratedKb();

    const out = JSON.parse(runCli("split-daily-shards"));
    expect(out).toMatchObject({ years: { "2023": 1, "2026": 1 }, kept: 2 });

    // Shards contain exactly their year's entries.
    const shard2023 = readKb("Wiki/index-2023.md");
    expect(shard2023).toContain("# Daily Notes Index 2023");
    expect(shard2023).toContain("2023-01-01.summary");
    expect(shard2023).not.toContain("2026-07-06");

    const shard2026 = readKb("Wiki/index-2026.md");
    expect(shard2026).toContain("# Daily Notes Index 2026");
    expect(shard2026).toContain("2026-07-06.summary");

    // Main index keeps Concepts + Notes + non-year DailyNotes + Archive links.
    const main = readKb("Wiki/index.md");
    expect(main).toContain(
      "[[Wiki/Summaries/Notes/redis.summary]] — Redis note",
    );
    expect(main).toContain(
      "[[Wiki/Summaries/Calendar/DailyNotes/raindrop-bookmarks-2026.summary]] — Bookmarks",
    );
    expect(main).toContain("- [[Wiki/index-2023|2023]]");
    expect(main).toContain("- [[Wiki/index-2026|2026]]");
    expect(main).not.toContain("2023-01-01");
    expect(main).not.toContain("2026-07-06");

    // Backup of the original index exists.
    const wikiFiles = readdirSync(join(kb, "Wiki"));
    expect(wikiFiles.some((f) => f.startsWith("index.md.bak-"))).toBe(true);
  });

  it("is idempotent: a second run reports no-op", () => {
    buildMigratedKb();
    runCli("split-daily-shards");

    const second = runCli("split-daily-shards");
    expect(second).toContain("no-op");
  });
});

// ── Cross-shard maintenance commands ────────────────────

describe("delete-dead-links", () => {
  it("removes dead summary links from both the main index and year shards", () => {
    writeKb("Wiki/Summaries/Notes/alive.summary.md", "body");
    writeKb(
      "Wiki/Summaries/Calendar/DailyNotes/2023/2023-01-01.summary.md",
      "body",
    );
    writeKb(
      "Wiki/index.md",
      `# Knowledge Base Index

## Concepts

- [[Wiki/Concepts/redis|Redis]] — In-memory data store

## Summaries

- [[Wiki/Summaries/Notes/alive.summary]] — Alive
- [[Wiki/Summaries/Notes/dead.summary]] — Dead in main
`,
    );
    writeKb(
      "Wiki/index-2023.md",
      `# Daily Notes Index 2023

## Summaries

- [[Wiki/Summaries/Calendar/DailyNotes/2023/2023-01-01.summary]] — Alive in shard
- [[Wiki/Summaries/Calendar/DailyNotes/2023/2023-01-02.summary]] — Dead in shard
`,
    );

    const out = JSON.parse(runCli("delete-dead-links"));
    expect(out).toEqual({ concepts: 1, summaries: 2 });

    const main = readKb("Wiki/index.md");
    expect(main).toContain("Alive");
    expect(main).not.toContain("Dead in main");

    const shard = readKb("Wiki/index-2023.md");
    expect(shard).toContain("Alive in shard");
    expect(shard).not.toContain("Dead in shard");
  });
});

describe("sort", () => {
  it("sorts the main index and each shard independently", () => {
    writeKb("Wiki/Summaries/Notes/b.summary.md", "body");
    writeKb("Wiki/Summaries/Notes/a.summary.md", "body");
    writeKb(
      "Wiki/index.md",
      `# Knowledge Base Index

## Concepts

- [[Wiki/Concepts/redis|Redis]] — In-memory data store

## Summaries

- [[Wiki/Summaries/Notes/b.summary]] — B
- [[Wiki/Summaries/Notes/a.summary]] — A
`,
    );
    writeKb(
      "Wiki/index-2026.md",
      `# Daily Notes Index 2026

## Summaries

- [[Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary]] — Today
- [[Wiki/Summaries/Calendar/DailyNotes/2026/2026-01-01.summary]] — Earlier
`,
    );

    runCli("sort");

    const main = readKb("Wiki/index.md");
    expect(main.indexOf("a.summary")).toBeLessThan(main.indexOf("b.summary"));

    const shard = readKb("Wiki/index-2026.md");
    expect(shard.indexOf("2026-01-01")).toBeLessThan(
      shard.indexOf("2026-07-06"),
    );
  });
});
