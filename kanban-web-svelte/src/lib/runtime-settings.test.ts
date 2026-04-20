import { describe, expect, it, vi } from "vitest";

import {
  readRuntimeConnectionFromStorage,
  writeRuntimeConnectionToStorage,
} from "./runtime-settings";

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

describe("runtime-settings", () => {
  it("falls back to defaults when getItem throws", () => {
    const storage: StorageLike = {
      getItem() {
        throw new Error("blocked");
      },
      setItem: vi.fn(),
    };

    expect(
      readRuntimeConnectionFromStorage(storage, {
        defaultBaseUrl: "http://127.0.0.1:17888",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:17888",
      token: "",
    });
  });

  it("swallows setItem errors and returns false", () => {
    const storage: StorageLike = {
      getItem: vi.fn(() => null),
      setItem() {
        throw new Error("quota exceeded");
      },
    };

    expect(
      writeRuntimeConnectionToStorage(storage, {
        baseUrl: "http://127.0.0.1:17888",
        token: "test-token",
      }),
    ).toBe(false);
  });

  it("reads and writes values when storage is available", () => {
    const map = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };

    expect(
      readRuntimeConnectionFromStorage(storage, {
        defaultBaseUrl: "http://127.0.0.1:17888",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:17888",
      token: "",
    });

    expect(
      writeRuntimeConnectionToStorage(storage, {
        baseUrl: "http://127.0.0.1:19999",
        token: "abc",
      }),
    ).toBe(true);

    expect(
      readRuntimeConnectionFromStorage(storage, {
        defaultBaseUrl: "http://127.0.0.1:17888",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:19999",
      token: "abc",
    });
  });
});
