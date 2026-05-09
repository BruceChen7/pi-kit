declare module "glimpseui" {
  export type GlimpseWindow = {
    on(
      event: "message",
      handler: (message: unknown) => void | Promise<void>,
    ): void;
    send?(js: string): void;
  };

  export type GlimpseWindowOptions = {
    width?: number;
    height?: number;
    title?: string;
  };

  export function open(
    html: string,
    options?: GlimpseWindowOptions,
  ): GlimpseWindow;
}
