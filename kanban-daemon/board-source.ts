import fs from "node:fs";

export type KanbanBoardSource<TSnapshot> = {
  start: () => void;
  stop: () => void;
  refresh: () => TSnapshot;
  getSnapshot: () => TSnapshot | null;
  subscribe: (listener: (snapshot: TSnapshot) => void) => () => void;
};

export function createKanbanBoardSource<TSnapshot>(input: {
  boardPath: string;
  readBoard: () => TSnapshot;
  pollIntervalMs?: number;
}): KanbanBoardSource<TSnapshot> {
  let started = false;
  let snapshot: TSnapshot | null = null;
  const listeners = new Set<(snapshot: TSnapshot) => void>();
  const interval = input.pollIntervalMs ?? 250;

  function notify(nextSnapshot: TSnapshot): void {
    for (const listener of listeners) {
      listener(nextSnapshot);
    }
  }

  function refreshAndMaybeNotify(notifyListeners: boolean): TSnapshot {
    const nextSnapshot = input.readBoard();
    snapshot = nextSnapshot;
    if (notifyListeners) {
      notify(nextSnapshot);
    }
    return nextSnapshot;
  }

  function handleFileChange(current: fs.Stats, previous: fs.Stats): void {
    if (current.mtimeMs === previous.mtimeMs) {
      return;
    }

    refreshAndMaybeNotify(true);
  }

  return {
    start() {
      if (started) {
        return;
      }

      started = true;
      refreshAndMaybeNotify(false);
      fs.watchFile(input.boardPath, { interval }, handleFileChange);
    },
    stop() {
      if (!started) {
        return;
      }

      started = false;
      fs.unwatchFile(input.boardPath, handleFileChange);
    },
    refresh() {
      return refreshAndMaybeNotify(true);
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener: (nextSnapshot: TSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
