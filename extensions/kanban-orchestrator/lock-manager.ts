type WorktreeTask<T> = () => Promise<T>;

type WorktreeQueueState = {
  tail: Promise<unknown>;
  pendingCount: number;
};

export class WorktreeLockManager {
  private readonly queues = new Map<string, WorktreeQueueState>();

  async run<T>(worktreeKey: string, task: WorktreeTask<T>): Promise<T> {
    const key = worktreeKey.trim();
    if (!key) {
      throw new Error("worktree key must not be empty");
    }

    const state = this.queues.get(key) ?? {
      tail: Promise.resolve(),
      pendingCount: 0,
    };
    state.pendingCount += 1;
    this.queues.set(key, state);

    const resultPromise = state.tail.then(task, task);

    state.tail = resultPromise.finally(() => {
      const current = this.queues.get(key);
      if (!current) return;
      current.pendingCount -= 1;
      if (current.pendingCount <= 0) {
        this.queues.delete(key);
      }
    });

    return resultPromise;
  }
}
