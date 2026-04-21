import {
  RECENT_PROJECT_LIMIT,
  type RecentProjectEntry,
  upsertRecentProjects,
} from "./project-access";

const DATABASE_NAME = "kanban-project-access";
const STORE_NAME = "state";
const STATE_KEY = "project-access-state";

type ProjectPermissionState = "granted" | "prompt" | "denied";

type ProjectPermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<ProjectPermissionState>;
  requestPermission?(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<ProjectPermissionState>;
};

type PersistedProjectState = {
  key: typeof STATE_KEY;
  entries: BrowserRecentProject[];
  lastProjectId: string | null;
};

export type BrowserRecentProject = RecentProjectEntry<ProjectPermissionHandle>;

export function supportsProjectDirectoryAccess(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickProjectDirectory(): Promise<ProjectPermissionHandle> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: () => Promise<ProjectPermissionHandle>;
    }
  ).showDirectoryPicker;
  return picker();
}

export async function ensureProjectAccess(input: {
  handle: ProjectPermissionHandle;
  mode: "restore" | "select" | "recent";
}): Promise<boolean> {
  const permissionDescriptor = {
    mode: "readwrite" as const,
  };
  const currentPermission =
    await input.handle.queryPermission?.(permissionDescriptor);
  if (currentPermission === "granted") {
    return true;
  }

  if (input.mode === "restore") {
    return false;
  }

  const nextPermission =
    await input.handle.requestPermission?.(permissionDescriptor);
  return nextPermission === "granted";
}

export class BrowserProjectAccessStore {
  async listRecentProjects(): Promise<BrowserRecentProject[]> {
    const state = await this.loadState();
    return state.entries;
  }

  async getLastProject(): Promise<BrowserRecentProject | null> {
    const state = await this.loadState();
    if (!state.lastProjectId) {
      return null;
    }

    return (
      state.entries.find((entry) => entry.id === state.lastProjectId) ?? null
    );
  }

  async rememberProject(
    handle: ProjectPermissionHandle,
  ): Promise<BrowserRecentProject> {
    const state = await this.loadState();
    const existing = await findMatchingProject(state.entries, handle);
    const candidate: BrowserRecentProject = {
      id: existing?.id ?? createProjectId(),
      name: handle.name,
      handle,
      lastUsedAt: new Date().toISOString(),
    };
    const entries = await upsertRecentProjects({
      entries: state.entries,
      candidate,
      limit: RECENT_PROJECT_LIMIT,
    });

    await this.saveState({
      key: STATE_KEY,
      entries,
      lastProjectId: candidate.id,
    });

    return entries[0] ?? candidate;
  }

  async markProjectActive(project: BrowserRecentProject): Promise<void> {
    const entries = await upsertRecentProjects({
      entries: await this.listRecentProjects(),
      candidate: {
        ...project,
        lastUsedAt: new Date().toISOString(),
      },
      limit: RECENT_PROJECT_LIMIT,
    });

    await this.saveState({
      key: STATE_KEY,
      entries,
      lastProjectId: project.id,
    });
  }

  private async loadState(): Promise<PersistedProjectState> {
    const database = await openProjectDatabase();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const state = await requestToPromise<PersistedProjectState | undefined>(
      store.get(STATE_KEY),
    );

    return (
      state ?? {
        key: STATE_KEY,
        entries: [],
        lastProjectId: null,
      }
    );
  }

  private async saveState(state: PersistedProjectState): Promise<void> {
    const database = await openProjectDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(state);
    await transactionToPromise(transaction);
  }
}

async function openProjectDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) {
      database.createObjectStore(STORE_NAME, {
        keyPath: "key",
      });
    }
  };

  return requestToPromise(request);
}

function requestToPromise<TResult>(
  request: IDBRequest<TResult>,
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    };
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    };
  });
}

async function findMatchingProject(
  entries: BrowserRecentProject[],
  handle: ProjectPermissionHandle,
): Promise<BrowserRecentProject | null> {
  for (const entry of entries) {
    if (await entry.handle.isSameEntry(handle)) {
      return entry;
    }
  }

  return null;
}

function createProjectId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
