type GlimpseLikeWindow = Window & {
  glimpse?: {
    close?(): void;
  };
};

export function registerGlimpseCloseShortcuts(
  target: Window = window,
): () => void {
  const handleKeydown = (event: KeyboardEvent): void => {
    if (!event.metaKey || event.key.toLowerCase() !== "w") return;
    event.preventDefault();
    (target as GlimpseLikeWindow).glimpse?.close?.();
  };

  target.addEventListener("keydown", handleKeydown);
  return () => target.removeEventListener("keydown", handleKeydown);
}
