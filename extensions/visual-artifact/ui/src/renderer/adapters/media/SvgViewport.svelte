<script lang="ts">
/**
 * Generic interactive SVG viewport — zoom, pan, fit, fullscreen, source toggle.
 *
 * Thin imperative shell: owns all DOM reads/writes and event wiring, and
 * delegates every geometric/decision computation to the pure core in
 * svg-viewport.ts. Interaction state lives in non-reactive locals (mutated
 * at pointer-event frequency); only UI-level state is reactive.
 *
 * Ported from plannotator's MermaidBlock.tsx (React) to Svelte 5 runes.
 */

import { type CopyIo, copyText } from "./copy-text.ts";
import {
  clampZoom,
  computeView,
  exceedsDragThreshold,
  fitBoundsToContainer,
  isAtBaseZoom,
  isZoomModifierDown,
  MAX_ZOOM,
  MIN_ZOOM,
  normalizeSvgMarkup,
  parseViewBoxFromMarkup,
  stepZoom,
  type ViewBox,
  zoomShortcutForKey,
} from "./svg-viewport.ts";

let {
  svg = "",
  source = "",
  label = "Diagram",
}: { svg?: string; source?: string; label?: string } = $props();

/* ------------------------------------------------------------------ */
/*  Reactive UI state                                                  */
/* ------------------------------------------------------------------ */

let showSource = $state(false);
let isExpanded = $state(false);

// Element refs as $state so effects re-run when the body remounts
// (inline ↔ expanded moves the snippet's DOM).
let containerEl = $state<HTMLDivElement>();
let overlayEl = $state<HTMLDivElement>();

const normalizedSvg = $derived(normalizeSvgMarkup(svg));

/* ------------------------------------------------------------------ */
/*  Non-reactive interaction state (no re-render at pointer frequency) */
/* ------------------------------------------------------------------ */

let zoomLevel = 1;
let naturalBounds: ViewBox | null = null;
let baseViewBox: ViewBox | null = null;
let panOffset = { x: 0, y: 0 };
let isDragging = false;
let didDrag = false;
let dragStart = { x: 0, y: 0 };
let panStart = { x: 0, y: 0 };

/**
 * Reactive container aspect (width / height) of the diagram content.
 * Drives the container's CSS aspect-ratio so wide diagrams fill the
 * container width instead of letterboxing inside a fixed-height box.
 */
let viewportAspect = $state<number | null>(null);

function aspectOf(bounds: ViewBox | null): number | null {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  return bounds.width / bounds.height;
}

// Imperative control refs (updated without re-render, like the source's refs)
let zoomInBtn = $state<HTMLButtonElement>();
let zoomOutBtn = $state<HTMLButtonElement>();
let zoomBadge = $state<HTMLSpanElement>();

// Copy-to-clipboard feedback state — drives the button icon (copy/✓/✕)
// and the "Copied" / "Copy failed" badge below the control column.
let copyState = $state<"idle" | "copied" | "failed">("idle");
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

/* ------------------------------------------------------------------ */
/*  DOM writers (the only place viewBox/state hits the DOM)            */
/* ------------------------------------------------------------------ */

function applyViewToDom(): void {
  const el = containerEl;
  if (!el || !baseViewBox) return;
  const svgEl = el.querySelector("svg");
  if (!(svgEl instanceof SVGSVGElement)) return;
  const vb = computeView(baseViewBox, zoomLevel, panOffset);
  svgEl.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
}

function updateZoom(next: number): void {
  zoomLevel = clampZoom(next);
  applyViewToDom();

  if (zoomInBtn) zoomInBtn.disabled = zoomLevel >= MAX_ZOOM;
  if (zoomOutBtn) zoomOutBtn.disabled = zoomLevel <= MIN_ZOOM;
  if (zoomBadge) {
    const show = !isAtBaseZoom(zoomLevel);
    zoomBadge.textContent = show ? `${Math.round(zoomLevel * 100)}%` : "";
    zoomBadge.hidden = !show;
  }
}

function fitToCurrentViewport(): void {
  const el = containerEl;
  if (!el || !naturalBounds) return;
  const svgEl = el.querySelector("svg");
  if (!(svgEl instanceof SVGSVGElement)) return;

  const rect = el.getBoundingClientRect();
  const fitted = fitBoundsToContainer(naturalBounds, rect.width, rect.height);
  baseViewBox = fitted;
  panOffset = { x: 0, y: 0 };
  updateZoom(1);
}

/* ------------------------------------------------------------------ */
/*  Lifecycle effects                                                  */
/* ------------------------------------------------------------------ */

// Reset interaction state when the diagram content changes.
$effect(() => {
  const markup = normalizedSvg;
  zoomLevel = 1;
  panOffset = { x: 0, y: 0 };
  baseViewBox = null;
  naturalBounds = markup ? parseViewBoxFromMarkup(markup) : null;
  viewportAspect = aspectOf(naturalBounds);
  isExpanded = false;
});

// Reset zoom/pan when switching from source back to diagram.
$effect(() => {
  if (showSource) {
    isExpanded = false;
    return;
  }
  zoomLevel = 1;
  panOffset = { x: 0, y: 0 };
  baseViewBox = null;
});

// Prepare the injected SVG element and apply the initial fit. Runs whenever
// the body (re)mounts: content change, source toggle, inline ↔ expanded.
$effect(() => {
  const el = containerEl;
  const markup = normalizedSvg;
  if (!el || !markup || showSource) return;
  void isExpanded; // re-fit after the body remounts in the overlay

  const svgEl = el.querySelector("svg");
  if (!(svgEl instanceof SVGSVGElement)) return;

  svgEl.style.maxWidth = "none";
  svgEl.style.width = "100%";
  svgEl.style.height = "100%";
  svgEl.style.display = "block";
  svgEl.setAttribute("width", "100%");
  svgEl.setAttribute("height", "100%");
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

  let cancelled = false;

  const applyInitialView = () => {
    if (cancelled) return;
    if (!naturalBounds) {
      naturalBounds = parseViewBoxFromMarkup(markup);
      viewportAspect = aspectOf(naturalBounds);
    }
    if (!naturalBounds) return;
    fitToCurrentViewport();
  };

  // Double-RAF + timeout fallback: Safari may need an extra frame before the
  // injected SVG has measurable layout (ported from the source component).
  const raf = requestAnimationFrame(() =>
    requestAnimationFrame(applyInitialView),
  );
  const timer = window.setTimeout(applyInitialView, 120);

  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
  };
});

// Wheel zoom — requires Ctrl/Meta so it doesn't hijack page scrolling.
// Plain wheel scrolls the page normally; Ctrl/Meta+wheel zooms the diagram.
$effect(() => {
  const el = containerEl;
  if (!el || showSource) return;

  const handleWheel = (event: WheelEvent) => {
    if (!isZoomModifierDown(event.ctrlKey, event.metaKey)) return;
    if (Math.abs(event.deltaY) < 0.1) return;
    event.preventDefault();
    applyWheelZoomDelta(event.deltaY);
  };

  el.addEventListener("wheel", handleWheel, { passive: false });
  return () => el.removeEventListener("wheel", handleWheel);
});

// Pinch zoom (ctrl/meta + wheel) inside the expanded overlay, handled in the
// capture phase so it wins over the container's own wheel listener.
$effect(() => {
  const overlay = overlayEl;
  if (!overlay || !isExpanded || showSource) return;

  const handlePinchWheel = (event: WheelEvent) => {
    if (!isZoomModifierDown(event.ctrlKey, event.metaKey)) return;
    const target = event.target;
    if (!(target instanceof Node) || !overlay.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    applyWheelZoomDelta(event.deltaY);
  };

  window.addEventListener("wheel", handlePinchWheel, {
    passive: false,
    capture: true,
  });
  return () =>
    window.removeEventListener("wheel", handlePinchWheel, { capture: true });
});

// Cmd/Ctrl+`+` / Cmd/Ctrl+`-` / Cmd/Ctrl+`0` zoom shortcuts — window-level
// so they work without hovering the diagram. Ignored while typing in
// editable elements and in source view; preventDefault stops the browser's
// own page zoom (Cmd+0 resets the page to actual size).
$effect(() => {
  if (showSource || !normalizedSvg) return;

  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    const shortcut = zoomShortcutForKey(event.key, {
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
    });
    if (shortcut === null) return;
    event.preventDefault();
    if (shortcut.type === "reset") {
      handleReset();
    } else {
      updateZoom(stepZoom(zoomLevel, shortcut.direction));
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
});

// Clear the copy feedback timer when the component unmounts.
$effect(() => {
  return () => {
    if (copyResetTimer) clearTimeout(copyResetTimer);
  };
});

// Escape to close + body scroll lock while expanded.
$effect(() => {
  if (!isExpanded) return;

  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") isExpanded = false;
  };
  window.addEventListener("keydown", handleKeyDown);

  return () => {
    document.body.style.overflow = previousOverflow;
    window.removeEventListener("keydown", handleKeyDown);
  };
});

// Re-fit on container resize, but only while at the natural zoom level.
$effect(() => {
  const el = containerEl;
  if (!el || showSource) return;
  if (typeof ResizeObserver === "undefined") return;

  const observer = new ResizeObserver(() => {
    if (!naturalBounds) return;
    if (!isAtBaseZoom(zoomLevel)) return;
    fitToCurrentViewport();
  });
  observer.observe(el);
  return () => observer.disconnect();
});

/* ------------------------------------------------------------------ */
/*  Event handlers                                                     */
/* ------------------------------------------------------------------ */

function applyWheelZoomDelta(deltaY: number): void {
  if (Math.abs(deltaY) < 0.1) return;
  updateZoom(stepZoom(zoomLevel, deltaY > 0 ? -1 : 1));
}

function handleZoomIn(): void {
  updateZoom(stepZoom(zoomLevel, 1));
}

function handleZoomOut(): void {
  updateZoom(stepZoom(zoomLevel, -1));
}

function handleFitToScreen(): void {
  fitToCurrentViewport();
}

// Restore the default view (Cmd/Ctrl+0): re-fit to the container, zero pan,
// zoom 100%. The unconditional updateZoom(1) also covers the no-bounds edge
// case where fitToCurrentViewport no-ops, so the badge never shows a stale
// percentage.
function handleReset(): void {
  fitToCurrentViewport();
  updateZoom(1);
}

/* ------------------------------------------------------------------ */
/*  Copy-to-clipboard (source code)                                    */
/* ------------------------------------------------------------------ */

// Real IO adapters for the pure copyText core: modern async API first,
// legacy textarea+execCommand fallback for non-secure webview contexts.
const copyIo: CopyIo = {
  async clipboardWrite(text) {
    if (!navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },
  legacyCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      textarea.remove();
    }
    return copied;
  },
};

function handleCopyClick(): void {
  if (!source) return;
  void copyText(source, copyIo).then((result) => {
    copyState = result;
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyState = "idle";
    }, 1500);
  });
}

function handleMouseDown(event: MouseEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  isDragging = true;
  didDrag = false;
  dragStart = { x: event.clientX, y: event.clientY };
  panStart = { ...panOffset };
  if (containerEl) containerEl.style.cursor = "grabbing";
}

function handleMouseMove(event: MouseEvent): void {
  if (!isDragging || !containerEl || !baseViewBox) return;
  const svgEl = containerEl.querySelector("svg");
  if (!(svgEl instanceof SVGSVGElement)) return;

  const dx = event.clientX - dragStart.x;
  const dy = event.clientY - dragStart.y;

  // Deadzone: sub-threshold movement stays a click (for annotation select).
  if (!didDrag && !exceedsDragThreshold(dx, dy)) return;
  didDrag = true;

  const rect = svgEl.getBoundingClientRect();
  const base = baseViewBox;
  const scaleX = base.width / zoomLevel / rect.width;
  const scaleY = base.height / zoomLevel / rect.height;

  panOffset = {
    x: panStart.x - dx * scaleX,
    y: panStart.y - dy * scaleY,
  };
  applyViewToDom();
}

function stopDragging(): void {
  if (!isDragging) return;
  isDragging = false;
  if (containerEl) containerEl.style.cursor = "grab";
}

// The trailing click after a pan must not reach the annotation layer.
function handleClick(event: MouseEvent): void {
  if (didDrag) {
    event.stopPropagation();
    didDrag = false;
  }
}
</script>

{#snippet controls()}
  <!--
    Rendered inside the diagram card (or a positioned source wrapper) so the
    column anchors to the card's top-right corner — NOT to the full-width
    page group. mousedown is shielded so clicking a control never starts a
    diagram pan (the controls live inside the pannable container).
  -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute top-2 right-2 z-10 flex flex-col items-center gap-1"
    onmousedown={(e) => e.stopPropagation()}
  >
    {#if source}
      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          showSource = !showSource;
        }}
        class="rounded-md bg-muted/85 p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        title={showSource ? "Show diagram" : "Show source"}
        aria-label={showSource ? "Show diagram" : "Show source"}
      >
        {#if showSource}
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        {:else}
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        {/if}
      </button>

      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          handleCopyClick();
        }}
        class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title={copyState === "copied"
          ? "Copied to clipboard"
          : copyState === "failed"
            ? "Copy failed"
            : "Copy mermaid code"}
        aria-label={copyState === "copied"
          ? "Copied to clipboard"
          : copyState === "failed"
            ? "Copy failed"
            : "Copy mermaid code"}
      >
        {#if copyState === "copied"}
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
            <path stroke-linecap="round" stroke-linejoin="round" d="M20 6 9 17l-5-5" />
          </svg>
        {:else if copyState === "failed"}
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
            <path stroke-linecap="round" stroke-linejoin="round" d="M18 6 6 18M6 6l12 12" />
          </svg>
        {:else}
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
            <rect x="9" y="9" width="13" height="13" rx="2" stroke-linecap="round" stroke-linejoin="round" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        {/if}
      </button>
    {/if}

    {#if !showSource && normalizedSvg}
      <div class="flex w-10 flex-col items-center gap-0.5 rounded-md bg-muted/85 p-0.5">
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            isExpanded = !isExpanded;
          }}
          class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={isExpanded ? "Exit expanded view" : "Expand diagram"}
          aria-label={isExpanded ? "Exit expanded view" : "Expand diagram"}
        >
          {#if isExpanded}
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 10h4V6M18 10h-4V6M6 14h4v4M18 14h-4v4" />
            </svg>
          {:else}
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </svg>
          {/if}
        </button>

        <button
          type="button"
          bind:this={zoomInBtn}
          onclick={(e) => {
            e.stopPropagation();
            handleZoomIn();
          }}
          class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
          title="Zoom in"
          aria-label="Zoom in"
        >
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14" />
          </svg>
        </button>

        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            handleFitToScreen();
          }}
          class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Fit to view"
          aria-label="Fit to view"
        >
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
            <circle cx="12" cy="12" r="4" stroke-linecap="round" stroke-linejoin="round" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 2v4M12 18v4M2 12h4M18 12h4" />
          </svg>
        </button>

        <button
          type="button"
          bind:this={zoomOutBtn}
          onclick={(e) => {
            e.stopPropagation();
            handleZoomOut();
          }}
          class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
          title="Zoom out"
          aria-label="Zoom out"
        >
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14" />
          </svg>
        </button>
      </div>

      <span
        bind:this={zoomBadge}
        hidden
        class="min-w-10 rounded bg-muted/85 px-1 py-0.5 text-center text-[10px] leading-tight text-muted-foreground tabular-nums"
      ></span>
    {/if}

    {#if copyState !== "idle"}
      <span
        role="status"
        class="min-w-10 rounded bg-muted/85 px-1 py-0.5 text-center text-[10px] leading-tight text-muted-foreground tabular-nums"
      >
        {copyState === "copied" ? "Copied" : "Copy failed"}
      </span>
    {/if}
  </div>
{/snippet}

{#snippet diagramBody()}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!--
    Inline mode: container height follows the diagram's natural aspect
    ratio (capped) so wide diagrams fill the width. Without a parseable
    viewBox, fall back to the previous fixed-height viewport.
    This div is the controls' positioning context (relative) — for tall
    diagrams the card is narrower than the page column, so anchoring the
    controls here keeps them inside the rendered diagram.
  -->
  <div
    bind:this={containerEl}
    class="relative cursor-grab overflow-hidden rounded-xl border border-border bg-card select-none {isExpanded
      ? 'h-full min-h-0'
      : viewportAspect
        ? 'min-h-[20rem]'
        : 'h-[min(65vh,36rem)] min-h-[20rem]'}"
    style={!isExpanded && viewportAspect
      ? `aspect-ratio: ${viewportAspect.toFixed(4)}; max-height: min(85vh, 44rem);`
      : undefined}
    onmousedown={handleMouseDown}
    onmousemove={handleMouseMove}
    onmouseup={stopDragging}
    onmouseleave={stopDragging}
    onclick={handleClick}
  >
    {@render controls()}
    {@html normalizedSvg}
  </div>
{/snippet}

<div class="group relative">
  {#if showSource || !normalizedSvg}
    <div class="relative">
      {#if !isExpanded}
        {@render controls()}
      {/if}
      <pre
        class="overflow-x-auto rounded-xl border border-border bg-muted p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap"
      ><code>{source}</code></pre>
    </div>
  {:else if !isExpanded}
    {@render diagramBody()}
  {:else}
    <div class="h-[min(65vh,36rem)] min-h-[20rem] rounded-xl border border-border bg-muted/50"></div>
  {/if}
</div>

{#if !showSource && normalizedSvg && isExpanded}
  <div bind:this={overlayEl} class="fixed inset-0 z-[9999] bg-background/90 p-4 backdrop-blur-sm md:p-6">
    <div class="mx-auto flex h-full max-w-[min(96vw,110rem)] flex-col gap-3">
      <div class="flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <span class="truncate">{label}</span>
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            isExpanded = false;
          }}
          class="rounded-md border border-border/60 bg-card/70 px-2.5 py-1.5 text-foreground hover:bg-card"
        >
          Close
        </button>
      </div>
      <div class="group relative min-h-0 flex-1">
        {@render diagramBody()}
      </div>
    </div>
  </div>
{/if}
