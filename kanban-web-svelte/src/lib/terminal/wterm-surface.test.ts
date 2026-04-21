import { describe, expect, it, vi } from "vitest";

import { createWTermSurface } from "./wterm-surface";

describe("createWTermSurface", () => {
  it("buffers stream chunks until the wterm instance finishes initializing", async () => {
    const writes: string[] = [];
    let resolveInit!: () => void;
    const initBarrier = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    class MockWTerm {
      async init(): Promise<void> {
        await initBarrier;
      }

      write(chunk: string): void {
        writes.push(chunk);
      }

      focus(): void {}
      destroy(): void {}
    }

    const surface = createWTermSurface(async () => ({
      WTerm: MockWTerm as unknown as typeof MockWTerm,
    }));

    const mountPromise = surface.mount({} as HTMLElement);
    surface.write("hello");
    surface.write(" world");

    expect(writes).toEqual([]);

    await Promise.resolve();
    resolveInit();
    await mountPromise;

    expect(writes).toEqual(["hello", " world"]);
  });

  it("forwards terminal input through the active input handler", async () => {
    let onData: ((data: string) => void) | undefined;
    const received: string[] = [];

    class MockWTerm {
      constructor(
        _container: HTMLElement,
        options?: {
          onData?: (data: string) => void;
        },
      ) {
        onData = options?.onData;
      }

      async init(): Promise<void> {}
      write(): void {}
      focus(): void {}
      destroy(): void {}
    }

    const surface = createWTermSurface(async () => ({
      WTerm: MockWTerm as unknown as typeof MockWTerm,
    }));

    surface.setInputHandler((data) => {
      received.push(data);
    });
    await surface.mount({} as HTMLElement);
    onData?.("pi hello\r");

    expect(received).toEqual(["pi hello\r"]);
  });

  it("destroys the active terminal when the surface is torn down", async () => {
    const destroy = vi.fn();

    class MockWTerm {
      async init(): Promise<void> {}
      write(): void {}
      focus(): void {}
      destroy(): void {
        destroy();
      }
    }

    const surface = createWTermSurface(async () => ({
      WTerm: MockWTerm as unknown as typeof MockWTerm,
    }));

    await surface.mount({} as HTMLElement);
    surface.destroy();

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
