/**
 * Tone-to-Tailwind-class mapping for the visual-artifact design system.
 *
 * Used by Card, Badge, and any component that supports semantic tone variants.
 *
 * Design tokens (warm neutral, single theme):
 *   clay  #d97757  – primary accent
 *   olive #788c5d  – success
 *   rust  #b04a3f  – danger / destructive
 *   oat   #e3dacc  – soft accent / info
 */

export type Tone = "default" | "success" | "warning" | "danger" | "info";

/**
 * Returns a border-left accent class for card-like containers.
 */
export function toneBorderClass(tone: Tone | string): string {
  const map: Record<string, string> = {
    success: "border-l-[3px] border-l-olive",
    warning: "border-l-[3px] border-l-[#d9a84b]",
    danger: "border-l-[3px] border-l-rust",
    info: "border-l-[3px] border-l-clay",
  };
  return map[tone] ?? "";
}

/**
 * Returns a full background + text class set for badge-like components.
 */
export function toneBadgeClass(tone: Tone | string): string {
  const map: Record<string, string> = {
    default: "bg-foreground text-background",
    secondary: "bg-secondary text-secondary-foreground",
    outline: "border border-border text-foreground bg-transparent",
    success: "bg-olive/10 text-olive border border-olive/20",
    danger: "bg-rust/10 text-rust border border-rust/20",
    warning: "bg-[#d9a84b]/10 text-[#d9a84b] border border-[#d9a84b]/20",
    info: "bg-clay/10 text-clay border border-clay/20",
  };
  return map[tone] ?? map.default;
}
