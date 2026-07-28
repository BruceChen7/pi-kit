/**
 * DOM helpers for annotation anchors and node identity matching.
 *
 * Mirrors the reference implementation in app/src/components/annotations/annotation-helpers.ts
 * but scoped to Glimpse DOM conventions.
 */

import type {
  AnnotationAnchor,
  AnnotationThread,
  NodeIdentity,
} from "./annotation-types.ts";

/**
 * Check whether an anchor matches a given node identity.
 * Prefers explicit nodeId when both sides have one; falls back to nodePath.
 */
export function nodeIdentityMatches(
  anchor: AnnotationAnchor,
  nodeId: string | undefined,
  nodePath: string,
): boolean {
  if (anchor.nodeId && nodeId) {
    return anchor.nodeId === nodeId;
  }
  return anchor.nodePath === nodePath;
}

/**
 * Derive a minimal NodeIdentity from a thread's anchor.
 */
export function threadNodeIdentity(thread: AnnotationThread): NodeIdentity {
  return {
    nodeId: thread.anchor.nodeId,
    nodePath: thread.anchor.nodePath,
  };
}

/**
 * Get all threads anchored to a given node.
 */
export function getThreadsForNode(
  threads: AnnotationThread[],
  nodeId: string | undefined,
  nodePath: string,
): AnnotationThread[] {
  return threads.filter((thread) =>
    nodeIdentityMatches(thread.anchor, nodeId, nodePath),
  );
}

/**
 * Count threads anchored to a given node.
 */
export function getThreadCount(
  threads: AnnotationThread[],
  nodeId: string | undefined,
  nodePath: string,
): number {
  return getThreadsForNode(threads, nodeId, nodePath).length;
}

/**
 * Escape a string for use in a CSS selector.
 */
export function cssEscape(value: string): string {
  if (typeof window !== "undefined" && "CSS" in window && window.CSS.escape) {
    return window.CSS.escape(value);
  }
  return value.replace(/(["'\\])/g, "\\$1");
}

/**
 * Find the DOM element for a node anchor.
 * Tries nodeId first (more stable), then falls back to nodePath.
 */
export function findAnchorElement(
  nodeId: string | undefined,
  nodePath: string,
): Element | null {
  if (typeof document === "undefined") return null;
  const selector = nodeId
    ? `[data-va-node-id="${cssEscape(nodeId)}"]`
    : `[data-va-node-path="${cssEscape(nodePath)}"]`;
  return document.querySelector(selector);
}

/**
 * Check whether a node anchor still exists in the DOM.
 */
export function isAnchorOrphaned(
  nodeId: string | undefined,
  nodePath: string,
): boolean {
  return !findAnchorElement(nodeId, nodePath);
}

/**
 * Scroll a node into view, centering it vertically.
 */
export function scrollToNode(
  nodeId: string | undefined,
  nodePath: string,
): void {
  if (typeof document === "undefined") return;
  const element = findAnchorElement(nodeId, nodePath);
  if (!element) return;
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "center",
  });
}

/**
 * Walk up the DOM tree from a target element to find the nearest
 * node with a data-va-node-path attribute.
 */
export function findClosestVaNode(
  target: EventTarget | null,
): NodeIdentity | null {
  const el = target as Element | null;
  if (!el) return null;
  const anchor = el.closest("[data-va-node-path]") as Element | null;
  if (!anchor) return null;

  const foundNodeId = anchor.getAttribute("data-va-node-id") ?? undefined;
  const foundNodePath = anchor.getAttribute("data-va-node-path") ?? undefined;
  const foundNodeType = anchor.getAttribute("data-va-node-type") ?? undefined;
  const foundNodeLabel = anchor.getAttribute("data-va-node-label") ?? undefined;

  if (!foundNodePath) return null;

  return {
    nodeId: foundNodeId,
    nodePath: foundNodePath,
    nodeType: foundNodeType,
    textSnippet: foundNodeLabel,
  };
}
