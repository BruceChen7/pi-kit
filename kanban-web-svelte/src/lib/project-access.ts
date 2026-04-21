export const RECENT_PROJECT_LIMIT = 5;

export type SameEntryHandle = {
  name: string;
  isSameEntry(other: SameEntryHandle): Promise<boolean>;
};

export type RecentProjectEntry<THandle extends SameEntryHandle> = {
  id: string;
  name: string;
  handle: THandle;
  lastUsedAt: string;
};

export async function upsertRecentProjects<THandle extends SameEntryHandle>(input: {
  entries: RecentProjectEntry<THandle>[];
  candidate: RecentProjectEntry<THandle>;
  limit?: number;
}): Promise<RecentProjectEntry<THandle>[]> {
  const nextEntries: RecentProjectEntry<THandle>[] = [input.candidate];

  for (const entry of input.entries) {
    if (await entry.handle.isSameEntry(input.candidate.handle)) {
      continue;
    }

    nextEntries.push(entry);

    if (nextEntries.length >= (input.limit ?? RECENT_PROJECT_LIMIT)) {
      break;
    }
  }

  return nextEntries;
}
