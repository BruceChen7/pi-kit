declare module "glimpseui" {
  export type GlimpseWindow = {
    on(
      event: "message",
      handler: (message: unknown) => void | Promise<void>,
    ): void;
    send?(js: string): void;
    close?(): void;
  };

  export type NativeHostInfo = {
    path: string;
    platform: string;
    extraArgs?: string[];
    buildHint?: string;
  };

  export function getNativeHostInfo(): NativeHostInfo;
}
