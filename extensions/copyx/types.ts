/**
 * Types and utilities for copyx plugin
 */

export function truncatePreview(
  text: string,
  maxLines = PREVIEW_MAX_LINES,
  maxChars = PREVIEW_MAX_CHARS,
): string {
  const forceEllipsis = (value: string): string => {
    if (maxChars <= 0) {
      return "";
    }
    if (maxChars <= 3) {
      return ".".repeat(maxChars);
    }
    if (value.length >= maxChars) {
      return `${value.slice(0, maxChars - 3)}...`;
    }
    return `${value}...`;
  };

  if (text === "") {
    return "";
  }

  const lines = text.split("\n");
  const resultLines: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if we've reached the line limit
    if (resultLines.length >= maxLines) {
      // Check if there are more lines after this one
      const hasMoreContent = i < lines.length - 1 || line !== "";
      if (hasMoreContent) {
        const separatorLength = resultLines.length > 0 ? 1 : 0;
        if (totalChars + separatorLength + 3 <= maxChars) {
          resultLines.push("...");
        } else {
          return forceEllipsis(resultLines.join("\n"));
        }
      }
      break;
    }

    const lineLength = line.length;
    const separatorLength = resultLines.length > 0 ? 1 : 0;
    const wouldExceed = totalChars + lineLength + separatorLength > maxChars;

    if (wouldExceed) {
      if (resultLines.length === 0) {
        // First line exceeds limit - truncate it
        const available = maxChars;
        if (available > 3) {
          resultLines.push(`${line.slice(0, available - 3)}...`);
        } else if (available > 0) {
          resultLines.push(".".repeat(available));
        } else {
          return "";
        }
      } else {
        // Not the first line - truncate with ellipsis
        const available = maxChars - totalChars - separatorLength - 3;
        if (available >= 0) {
          resultLines.push(`${line.slice(0, available)}...`);
        } else {
          return forceEllipsis(resultLines.join("\n"));
        }
      }
      break;
    }

    resultLines.push(line);
    totalChars += lineLength + separatorLength;
  }

  // Remove the last empty line if it exists (to indicate more content)
  if (resultLines.length > 0 && resultLines[resultLines.length - 1] === "") {
    resultLines.pop();
  }

  return resultLines.join("\n");
}

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
export const PREVIEW_MAX_LINES = 10;
export const PREVIEW_MAX_CHARS = 200;
