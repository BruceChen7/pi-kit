import os from "node:os";
import path from "node:path";

import { getRepoRoot } from "../shared/git.ts";
import { loadSettings } from "../shared/settings.ts";
import type { DiffxReviewConfig } from "./types.ts";

type DiffxReviewSettings = {
  enabled?: unknown;
  diffxCommand?: unknown;
  diffxPath?: unknown;
  host?: unknown;
  defaultPort?: unknown;
  autoOpen?: unknown;
  startMode?: unknown;
  reuseExistingSession?: unknown;
  healthcheckTimeoutMs?: unknown;
  startupTimeoutMs?: unknown;
};

export const DEFAULT_DIFFX_PATH = "~/work/diffx";

export const DEFAULT_CONFIG: DiffxReviewConfig = {
  enabled: true,
  diffxCommand: "diffx",
  diffxPath: path.resolve(os.homedir(), "work", "diffx"),
  host: "127.0.0.1",
  defaultPort: null,
  autoOpen: true,
  startMode: "dist",
  reuseExistingSession: true,
  healthcheckTimeoutMs: 1000,
  startupTimeoutMs: 15000,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const trimToNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const normalizePositiveNumber = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
};

const normalizeOptionalPort = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    return value > 0 && value <= 65535 ? value : null;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 && parsed <= 65535 ? parsed : null;
  }

  return null;
};

export const expandHomePath = (value: string): string => {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
};

export const normalizeDiffxReviewConfig = (
  value: unknown,
): DiffxReviewConfig => {
  const settings = isRecord(value) ? (value as DiffxReviewSettings) : {};
  const diffxCommand = trimToNull(settings.diffxCommand);
  const diffxPath = trimToNull(settings.diffxPath);
  const host = trimToNull(settings.host);

  return {
    enabled: normalizeBoolean(settings.enabled, DEFAULT_CONFIG.enabled),
    diffxCommand: diffxCommand ?? DEFAULT_CONFIG.diffxCommand,
    diffxPath: path.resolve(expandHomePath(diffxPath ?? DEFAULT_DIFFX_PATH)),
    host: host ?? DEFAULT_CONFIG.host,
    defaultPort: normalizeOptionalPort(settings.defaultPort),
    autoOpen: normalizeBoolean(settings.autoOpen, DEFAULT_CONFIG.autoOpen),
    startMode: "dist",
    reuseExistingSession: normalizeBoolean(
      settings.reuseExistingSession,
      DEFAULT_CONFIG.reuseExistingSession,
    ),
    healthcheckTimeoutMs: normalizePositiveNumber(
      settings.healthcheckTimeoutMs,
      DEFAULT_CONFIG.healthcheckTimeoutMs,
    ),
    startupTimeoutMs: normalizePositiveNumber(
      settings.startupTimeoutMs,
      DEFAULT_CONFIG.startupTimeoutMs,
    ),
  };
};

export const getDiffxReviewSettings = (
  settings: Record<string, unknown>,
): Record<string, unknown> => {
  const diffxReview = settings.diffxReview;
  return isRecord(diffxReview) ? diffxReview : {};
};

export const loadDiffxReviewConfig = (cwd: string): DiffxReviewConfig => {
  const repoRoot = getRepoRoot(cwd) ?? cwd;
  const { merged } = loadSettings(repoRoot);
  return normalizeDiffxReviewConfig(getDiffxReviewSettings(merged));
};
