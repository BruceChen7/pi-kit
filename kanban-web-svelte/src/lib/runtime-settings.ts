export type StorageLike = Pick<Storage, "getItem" | "setItem">;

const BASE_URL_KEY = "kanban.runtime.baseUrl";
const TOKEN_KEY = "kanban.runtime.token";

export function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readRuntimeConnectionFromStorage(
  storage: StorageLike | null,
  input: {
    defaultBaseUrl: string;
  },
): { baseUrl: string; token: string } {
  const baseUrl =
    readStorageItem(storage, BASE_URL_KEY)?.trim() || input.defaultBaseUrl;
  const token = readStorageItem(storage, TOKEN_KEY) ?? "";

  return {
    baseUrl,
    token,
  };
}

export function writeRuntimeConnectionToStorage(
  storage: StorageLike | null,
  input: {
    baseUrl: string;
    token: string;
  },
): boolean {
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(BASE_URL_KEY, input.baseUrl);
    storage.setItem(TOKEN_KEY, input.token);
    return true;
  } catch {
    return false;
  }
}

function readStorageItem(
  storage: StorageLike | null,
  key: string,
): string | null {
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
