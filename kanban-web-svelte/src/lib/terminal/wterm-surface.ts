import { loadWTermDom, type WTermDomModule } from "./wterm-loader";

export type WTermLoader = () => Promise<WTermDomModule>;
export type WTermInputHandler = (data: string) => void;

export type WTermSurface = {
  mount(container: HTMLElement): Promise<void>;
  reset(seedText?: string): Promise<void>;
  write(text: string): void;
  focus(): void;
  setInputHandler(handler: WTermInputHandler | null): void;
  destroy(): void;
};

export function createWTermSurface(
  loadWTerm: WTermLoader = loadWTermDom,
): WTermSurface {
  let activeContainer: HTMLElement | null = null;
  let activeTerm: WTermDomModule["WTerm"] extends new (
    ...args: never[]
  ) => infer Instance
    ? Instance | null
    : null = null;
  let bufferedChunks: string[] = [];
  let mountVersion = 0;
  let inputHandler: WTermInputHandler | null = null;

  async function createTerm(container: HTMLElement): Promise<void> {
    const version = ++mountVersion;

    if (activeTerm) {
      activeTerm.destroy();
      activeTerm = null;
    }

    if (typeof container.replaceChildren === "function") {
      container.replaceChildren();
    } else {
      container.innerHTML = "";
    }

    const { WTerm } = await loadWTerm();
    if (version !== mountVersion || activeContainer !== container) {
      return;
    }

    const nextTerm = new WTerm(container, {
      cursorBlink: true,
      onData: (data) => {
        inputHandler?.(data);
      },
    });

    await nextTerm.init();
    if (version !== mountVersion || activeContainer !== container) {
      nextTerm.destroy();
      return;
    }

    activeTerm = nextTerm;
    if (bufferedChunks.length === 0) {
      return;
    }

    for (const chunk of bufferedChunks) {
      nextTerm.write(chunk);
    }
    bufferedChunks = [];
  }

  return {
    async mount(container: HTMLElement): Promise<void> {
      activeContainer = container;
      await createTerm(container);
    },
    async reset(seedText = ""): Promise<void> {
      bufferedChunks = seedText ? [seedText] : [];
      if (!activeContainer) {
        return;
      }

      await createTerm(activeContainer);
    },
    write(text: string): void {
      if (!text) {
        return;
      }

      if (activeTerm) {
        activeTerm.write(text);
        return;
      }

      bufferedChunks.push(text);
    },
    focus(): void {
      activeTerm?.focus();
    },
    setInputHandler(handler: WTermInputHandler | null): void {
      inputHandler = handler;
    },
    destroy(): void {
      mountVersion += 1;
      bufferedChunks = [];
      inputHandler = null;
      activeTerm?.destroy();
      activeTerm = null;
      if (activeContainer) {
        if (typeof activeContainer.replaceChildren === "function") {
          activeContainer.replaceChildren();
        } else {
          activeContainer.innerHTML = "";
        }
      }
      activeContainer = null;
    },
  };
}
