import path from "node:path";
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { defaultReviewTargetKindFromAbsolutePath } from "../shared/review-targets.ts";
import {
  pathsFromWriteToolInput,
  type ToolTargetPath,
} from "../shared/tool-targets.ts";
import { WRITE_TOOL_NAMES } from "./constants.ts";
import type { PlanModeState } from "./state.ts";
import { isRecord, stringProperty } from "./state.ts";

export type ToolTargetPathResult =
  | { kind: "paths"; paths: ToolTargetPath[] }
  | { kind: "unresolved-write"; reason: string };

export const pathFromToolCall = (event: ToolCallEvent): string | null =>
  stringProperty(event.input, "path");

const targetPathResult = (
  toolName: string,
  paths: ToolTargetPath[],
): ToolTargetPathResult => {
  if (paths.length > 0) {
    return { kind: "paths", paths };
  }

  if (WRITE_TOOL_NAMES.has(toolName)) {
    return {
      kind: "unresolved-write",
      reason: "unable to determine target file paths",
    };
  }

  return { kind: "paths", paths: [{ rawPath: "." }] };
};

export const pathsFromToolCall = (
  event: ToolCallEvent,
): ToolTargetPathResult => {
  return targetPathResult(event.toolName, pathsFromWriteToolInput(event.input));
};

export const normalizeToolPath = (cwd: string, rawPath: string): string => {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return path.resolve(cwd, withoutAt);
};

export const relativeToolPath = (cwd: string, rawPath: string): string => {
  const absolutePath = normalizeToolPath(cwd, rawPath);
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath.split(path.sep).join("/");
};

export const isReviewArtifactPath = (cwd: string, rawPath: string): boolean =>
  defaultReviewTargetKindFromAbsolutePath(
    cwd,
    normalizeToolPath(cwd, rawPath),
  ) !== null;

export const isInsideDir = (targetPath: string, dirPath: string): boolean => {
  const relative = path.relative(
    path.resolve(dirPath),
    path.resolve(targetPath),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

export const isAllowedPath = (
  targetPath: string,
  cwd: string,
  allowedPaths: string[],
): boolean =>
  isInsideDir(targetPath, cwd) ||
  allowedPaths.some((allowedPath) =>
    isInsideDir(targetPath, path.resolve(cwd, allowedPath)),
  );

export const extractTextContent = (event: ToolResultEvent): string => {
  const rawContent = (event as { content?: unknown }).content;
  if (!Array.isArray(rawContent)) {
    return "";
  }
  return rawContent
    .flatMap((entry) => {
      if (
        isRecord(entry) &&
        entry.type === "text" &&
        typeof entry.text === "string"
      ) {
        return [entry.text];
      }
      return [];
    })
    .join("\n");
};

export const extractApprovedPath = (text: string): string | null => {
  const match = text.match(/Review approved for\s+(.+?\.(?:md|html))\.?/i);
  return match?.[1]?.trim() ?? null;
};

export const isApprovedReviewResult = (event: ToolResultEvent): boolean => {
  const details = (event as { details?: unknown }).details;
  return isRecord(details) && details.status === "approved";
};

export const getApprovedReviewPath = (
  event: ToolResultEvent,
  ctx: ExtensionContext,
): string | null => {
  const submittedPath = stringProperty(event.input, "path");
  if (submittedPath && isApprovedReviewResult(event)) {
    return relativeToolPath(ctx.cwd, submittedPath);
  }

  const approvedPath = extractApprovedPath(extractTextContent(event));
  if (!approvedPath) {
    return null;
  }
  return relativeToolPath(ctx.cwd, approvedPath);
};

export const formatReviewWaitReason = (state: PlanModeState): string => {
  const latestArtifactPath = state.getLatestReviewArtifactPath();
  if (
    latestArtifactPath &&
    !state.isApprovedReviewArtifactPath(latestArtifactPath)
  ) {
    return `latest artifact is not approved: ${latestArtifactPath}`;
  }
  if (state.todos.length > 0) {
    return "active TODO run has no approved plan/spec artifact";
  }
  return "plan review required";
};

export const turnWasAborted = (
  event: { messages?: readonly unknown[] },
  ctx: { signal?: AbortSignal },
): boolean => {
  if (ctx.signal?.aborted) {
    return true;
  }
  return (event.messages ?? []).some(
    (message) =>
      isRecord(message) &&
      message.role === "assistant" &&
      message.stopReason === "aborted",
  );
};
