import type { IgnoredSyncEnsureOnCommand, IgnoredSyncRule } from "../config.js";
import type { FeatureWorkflowSetupProfile } from "./shared.js";
import { isRecord, mergeEnsureOn, trimToNull } from "./shared.js";

type SettingsRecord = Record<string, unknown>;

function mergeRules(
  existingValue: unknown,
  presetRules: IgnoredSyncRule[],
): Record<string, unknown>[] {
  const existingRules: Record<string, unknown>[] = [];
  const seenPaths = new Set<string>();

  if (Array.isArray(existingValue)) {
    for (const item of existingValue) {
      if (!isRecord(item)) {
        continue;
      }

      const rulePath = trimToNull(item.path);
      if (!rulePath || seenPaths.has(rulePath)) {
        continue;
      }

      seenPaths.add(rulePath);
      existingRules.push({
        ...item,
        path: rulePath,
      });
    }
  }

  for (const presetRule of presetRules) {
    if (seenPaths.has(presetRule.path)) {
      continue;
    }

    seenPaths.add(presetRule.path);
    existingRules.push({
      path: presetRule.path,
      strategy: presetRule.strategy,
      required: presetRule.required,
      onMissing: {
        action: presetRule.onMissing.action,
        hook: presetRule.onMissing.hook,
      },
    });
  }

  return existingRules;
}

function mergeRecordWithPreset(
  existingValue: unknown,
  presetValue: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(existingValue)) {
    return {
      ...presetValue,
    };
  }

  return {
    ...presetValue,
    ...existingValue,
  };
}

export function mergeSettingsWithProfile(
  settings: SettingsRecord,
  profile: FeatureWorkflowSetupProfile,
): SettingsRecord {
  const nextSettings: SettingsRecord = {
    ...settings,
  };

  const featureWorkflow = isRecord(nextSettings.featureWorkflow)
    ? ({ ...nextSettings.featureWorkflow } as Record<string, unknown>)
    : {};

  if (typeof featureWorkflow.enabled !== "boolean") {
    featureWorkflow.enabled = true;
  }

  const ignoredSync = isRecord(featureWorkflow.ignoredSync)
    ? ({ ...featureWorkflow.ignoredSync } as Record<string, unknown>)
    : {};

  ignoredSync.enabled = true;
  ignoredSync.mode =
    typeof ignoredSync.mode === "string"
      ? ignoredSync.mode
      : profile.ignoredSyncPreset.mode;
  ignoredSync.ensureOn = mergeEnsureOn(
    ignoredSync.ensureOn,
    profile.ignoredSyncPreset.ensureOn as IgnoredSyncEnsureOnCommand[],
  );
  ignoredSync.rules = mergeRules(
    ignoredSync.rules,
    profile.ignoredSyncPreset.rules,
  );
  ignoredSync.lockfile = mergeRecordWithPreset(
    ignoredSync.lockfile,
    profile.ignoredSyncPreset.lockfile as Record<string, unknown>,
  );
  ignoredSync.fallback = mergeRecordWithPreset(
    ignoredSync.fallback,
    profile.ignoredSyncPreset.fallback as Record<string, unknown>,
  );
  ignoredSync.notifications = mergeRecordWithPreset(
    ignoredSync.notifications,
    profile.ignoredSyncPreset.notifications as Record<string, unknown>,
  );

  featureWorkflow.ignoredSync = ignoredSync;
  nextSettings.featureWorkflow = featureWorkflow;
  return nextSettings;
}
