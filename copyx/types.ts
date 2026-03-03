/**
 * Types for copyx plugin
 */

export interface MessageItem {
  /** 1-based index for display */
  index: number;
  /** Truncated preview text */
  preview: string;
  /** Original full text for copying */
  fullText: string;
  /** Turns ago (0 = current turn) */
  turnsAgo: number;
}

export const DEFAULT_MAX_MESSAGES = 20;
export const PREVIEW_MAX_LINES = 2;
export const PREVIEW_MAX_CHARS = 80;
