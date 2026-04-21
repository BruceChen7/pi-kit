import { describe, expect, it } from "vitest";

import {
  RECENT_PROJECT_LIMIT,
  upsertRecentProjects,
  type RecentProjectEntry,
  type SameEntryHandle,
} from "./project-access";

class FakeHandle implements SameEntryHandle {
  constructor(
    public readonly id: string,
    public readonly name: string,
  ) {}

  async isSameEntry(other: SameEntryHandle): Promise<boolean> {
    return other instanceof FakeHandle && other.id === this.id;
  }
}

function createEntry(id: string, lastUsedAt: string): RecentProjectEntry<FakeHandle> {
  return {
    id,
    name: id,
    handle: new FakeHandle(id, id),
    lastUsedAt,
  };
}

describe("upsertRecentProjects", () => {
  it("moves an existing project to the front and trims to the recent-project limit", async () => {
    const existing = Array.from({ length: RECENT_PROJECT_LIMIT }, (_, index) =>
      createEntry(`project-${index + 1}`, `2026-04-2${index}T10:00:00.000Z`),
    );

    const updated = await upsertRecentProjects({
      entries: existing,
      candidate: {
        id: "project-3",
        name: "project-3",
        handle: new FakeHandle("project-3", "project-3"),
        lastUsedAt: "2026-04-21T12:00:00.000Z",
      },
    });

    expect(updated).toHaveLength(RECENT_PROJECT_LIMIT);
    expect(updated.map((entry) => entry.id)).toEqual([
      "project-3",
      "project-1",
      "project-2",
      "project-4",
      "project-5",
    ]);
    expect(updated[0]?.lastUsedAt).toBe("2026-04-21T12:00:00.000Z");
  });
});
