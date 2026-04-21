export type WTermOptions = {
  cursorBlink?: boolean;
  onData?: (data: string) => void;
};

export type WTermInstance = {
  init(): Promise<unknown>;
  write(data: string): void;
  focus(): void;
  destroy(): void;
};

export type WTermConstructor = new (
  container: HTMLElement,
  options?: WTermOptions,
) => WTermInstance;

export type WTermDomModule = {
  WTerm: WTermConstructor;
};

export async function loadWTermDom(): Promise<WTermDomModule> {
  await import("@wterm/dom/css");
  const module = (await import("@wterm/dom")) as WTermDomModule;
  return module;
}
