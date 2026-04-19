import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getManagedFeatureRegistryPath,
  readManagedFeatureRegistry,
  upsertManagedFeatureBranch,
  writeManagedFeatureRegistry,
} from "./registry.js";

const tempDirs: string[] = [];

const createTempRepo = (): string => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-feature-registry-"),
  );
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("feature registry", () => {
  it("returns empty records when registry file is missing", () => {
    const repoRoot = createTempRepo();
    expect(readManagedFeatureRegistry(repoRoot)).toEqual([]);
  });

  it("upserts managed feature records", () => {
    const repoRoot = createTempRepo();

    const created = upsertManagedFeatureBranch(repoRoot, {
      branch: "main/checkout-v2",
      base: "main",
      slug: "checkout-v2",
      timestamp: "2026-04-19T00:00:00.000Z",
    });

    expect(created).toEqual({
      branch: "main/checkout-v2",
      base: "main",
      slug: "checkout-v2",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:00.000Z",
    });

    const updated = upsertManagedFeatureBranch(repoRoot, {
      branch: "main/checkout-v2",
      base: "main",
      slug: "checkout-v2",
      timestamp: "2026-04-19T01:00:00.000Z",
    });

    expect(updated).toEqual({
      branch: "main/checkout-v2",
      base: "main",
      slug: "checkout-v2",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T01:00:00.000Z",
    });
    expect(readManagedFeatureRegistry(repoRoot)).toEqual([updated]);
  });

  it("filters invalid or mismatched registry records when reading", () => {
    const repoRoot = createTempRepo();
    writeManagedFeatureRegistry(repoRoot, [
      {
        branch: "main/checkout-v2",
        base: "main",
        slug: "checkout-v2",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:00:00.000Z",
      },
    ]);

    const registryPath = getManagedFeatureRegistryPath(repoRoot);
    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          branch: "main/checkout-v2",
          base: "wrong",
          slug: "checkout-v2",
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        {
          branch: "release/2026-q2/login-timeout",
          base: "release/2026-q2",
          slug: "login-timeout",
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T01:00:00.000Z",
        },
      ]),
      "utf-8",
    );

    expect(readManagedFeatureRegistry(repoRoot)).toEqual([
      {
        branch: "release/2026-q2/login-timeout",
        base: "release/2026-q2",
        slug: "login-timeout",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T01:00:00.000Z",
      },
    ]);
  });

  it("dedupes by branch using latest updatedAt", () => {
    const repoRoot = createTempRepo();
    const registryPath = getManagedFeatureRegistryPath(repoRoot);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          branch: "main/checkout-v2",
          base: "main",
          slug: "checkout-v2",
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        {
          branch: "main/checkout-v2",
          base: "main",
          slug: "checkout-v2",
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T01:00:00.000Z",
        },
      ]),
      "utf-8",
    );

    expect(readManagedFeatureRegistry(repoRoot)).toEqual([
      {
        branch: "main/checkout-v2",
        base: "main",
        slug: "checkout-v2",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T01:00:00.000Z",
      },
    ]);
  });
});
