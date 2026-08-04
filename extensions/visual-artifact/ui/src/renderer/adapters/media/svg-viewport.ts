/**
 * Pure SVG-viewport geometry and markup helpers for SvgViewport.svelte.
 *
 * Ported from plannotator's MermaidBlock.tsx / mermaidSvg.ts, split into a
 * functional core: no DOM, no Svelte, no mermaid — value in / value out.
 * The Svelte shell owns all DOM reads/writes (querySelector, setAttribute,
 * getBoundingClientRect) and delegates every decision to this module.
 */

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ZOOM_STEP = 0.25;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
export const DRAG_THRESHOLD_PX = 5;

/**
 * Parse the base viewBox from SVG markup before DOM mount.
 * Prefers the viewBox attribute; falls back to width/height attributes.
 * Returns null when no usable bounds can be derived.
 */
export function parseViewBoxFromMarkup(markup: string): ViewBox | null {
  const viewBoxMatch = markup.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (viewBoxMatch?.[1]) {
    const values = viewBoxMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map((value) => Number.parseFloat(value));

    if (
      values.length === 4 &&
      values.every((value) => Number.isFinite(value))
    ) {
      const [x, y, width, height] = values;
      if (width > 0 && height > 0) {
        return { x, y, width, height };
      }
    }
  }

  const widthMatch = markup.match(/\bwidth\s*=\s*"([0-9.]+)(?:px)?"/i);
  const heightMatch = markup.match(/\bheight\s*=\s*"([0-9.]+)(?:px)?"/i);
  const width = widthMatch?.[1] ? Number.parseFloat(widthMatch[1]) : NaN;
  const height = heightMatch?.[1] ? Number.parseFloat(heightMatch[1]) : NaN;
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  ) {
    return { x: 0, y: 0, width, height };
  }

  return null;
}

/**
 * Compute the viewBox for a zoom/pan state relative to a base viewBox.
 * Zoom keeps the base center fixed, then pan shifts in viewBox units.
 */
export function computeView(
  base: ViewBox,
  zoom: number,
  pan: { x: number; y: number },
): ViewBox {
  const zoomedWidth = base.width / zoom;
  const zoomedHeight = base.height / zoom;
  const centerX = base.x + base.width / 2;
  const centerY = base.y + base.height / 2;
  return {
    x: centerX - zoomedWidth / 2 + pan.x,
    y: centerY - zoomedHeight / 2 + pan.y,
    width: zoomedWidth,
    height: zoomedHeight,
  };
}

/**
 * Pad content bounds to the container's aspect ratio so the diagram fits
 * without distortion (preserveAspectRatio="xMidYMid meet" does the rest).
 * Container dimensions are clamped to >= 1 to avoid division by zero.
 */
export function fitBoundsToContainer(
  bounds: ViewBox,
  containerWidth: number,
  containerHeight: number,
): ViewBox {
  const safeWidth = Math.max(containerWidth, 1);
  const safeHeight = Math.max(containerHeight, 1);
  const contentRatio = bounds.width / bounds.height;
  const containerRatio = safeWidth / safeHeight;

  if (contentRatio > containerRatio) {
    const targetHeight = bounds.width / containerRatio;
    const extra = (targetHeight - bounds.height) / 2;
    return {
      x: bounds.x,
      y: bounds.y - extra,
      width: bounds.width,
      height: targetHeight,
    };
  }

  const targetWidth = bounds.height * containerRatio;
  const extra = (targetWidth - bounds.width) / 2;
  return {
    x: bounds.x - extra,
    y: bounds.y,
    width: targetWidth,
    height: bounds.height,
  };
}

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/** Step zoom by one ZOOM_STEP in the given direction, clamped to bounds. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  return clampZoom(zoom + direction * ZOOM_STEP);
}

export interface ZoomShortcutModifiers {
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * Decide the zoom direction for a Cmd/Ctrl+`+` / Cmd/Ctrl+`-` keyboard
 * shortcut. Pure: takes primitive key/modifier values (no DOM types), so
 * the Svelte shell unpacks the KeyboardEvent and delegates here.
 *
 * Accepts `+` (Shift+= on US/CN layouts), `=` (same key without Shift) and
 * numpad variants for zoom in; `-` and `_` (Shift+-) for zoom out. Either
 * Cmd or Ctrl works (mirrors the wheel handler's ctrlKey || metaKey);
 * Alt-modified combos are ignored.
 *
 * Returns 1 (zoom in), -1 (zoom out), or null when the combo is not a zoom
 * shortcut.
 */
export function zoomDirectionForKey(
  key: string,
  modifiers: ZoomShortcutModifiers = {},
): 1 | -1 | null {
  if (!modifiers.meta && !modifiers.ctrl) return null;
  if (modifiers.alt) return null;
  switch (key) {
    case "+":
    case "=":
      return 1;
    case "-":
    case "_":
      return -1;
    default:
      return null;
  }
}

/**
 * Distinguish a drag (pan) from a plain click (annotation select).
 * Strictly greater than the threshold counts as a drag.
 */
export function exceedsDragThreshold(
  dx: number,
  dy: number,
  threshold = DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/**
 * Bake sizing attrs into the SVG markup so they survive repeated
 * {@html} re-injection — imperative setAttribute gets wiped on remount.
 * Idempotent: normalizing normalized markup returns it unchanged.
 */
export function normalizeSvgMarkup(markup: string): string {
  return markup.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    let next = attrs;

    if (/\bstyle\s*=\s*"/i.test(next)) {
      next = next.replace(
        /\bstyle\s*=\s*"([^"]*)"/i,
        (_m, styleVal: string) => {
          const rules = styleVal
            .split(";")
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && !/^max-width\s*:/i.test(s));
          rules.push("max-width: none");
          return `style="${rules.join("; ")}"`;
        },
      );
    } else {
      next += ' style="max-width: none"';
    }

    if (!/\bpreserveAspectRatio\s*=/i.test(next)) {
      next += ' preserveAspectRatio="xMidYMid meet"';
    }
    if (!/\bheight\s*=/i.test(next)) {
      next += ' height="100%"';
    }

    return `<svg${next}>`;
  });
}
