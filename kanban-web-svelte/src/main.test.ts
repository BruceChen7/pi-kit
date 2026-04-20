import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mountMock, appComponent } = vi.hoisted(() => ({
  mountMock: vi.fn(),
  appComponent: {},
}));

vi.mock("svelte", () => ({
  mount: mountMock,
}));

vi.mock("./App.svelte", () => ({
  default: appComponent,
}));

describe("main", () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    vi.resetModules();
    mountMock.mockReset();
  });

  afterEach(() => {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
      return;
    }

    globalThis.document = originalDocument;
  });

  it("mounts App into #app with the Svelte 5 mount API", async () => {
    const target = { id: "app" };
    globalThis.document = {
      getElementById: vi.fn(() => target),
    } as unknown as Document;

    await import("./main");

    expect(globalThis.document.getElementById).toHaveBeenCalledWith("app");
    expect(mountMock).toHaveBeenCalledWith(appComponent, { target });
  });
});
