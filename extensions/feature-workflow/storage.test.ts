import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type FeatureRecord,
  listFeatureRecords,
  readFeatureRecord,
  writeFeatureRecord,
} from "./storage.js";

const createTempRepo = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-feature-workflow-"));

describe("storage", () => {
  it("writes and reads feature records", () => {
    const repoRoot = createTempRepo();

    const record: FeatureRecord = {
      id: "feat-checkout-v2",
      name: "Checkout V2",
      type: "feat",
      slug: "checkout-v2",
      branch: "feat/checkout-v2",
      base: "main",
      worktreePath: "/tmp/repo.feat-checkout-v2",
      status: "active",
      createdAt: "2026-04-17T00:00:00Z",
      updatedAt: "2026-04-17T00:00:00Z",
    };

    writeFeatureRecord(repoRoot, record);
    expect(readFeatureRecord(repoRoot, record.id)).toEqual(record);
  });

  it("lists records sorted by updatedAt desc", () => {
    const repoRoot = createTempRepo();

    const a: FeatureRecord = {
      id: "feat-a",
      name: "A",
      type: "feat",
      slug: "a",
      branch: "feat/a",
      base: "main",
      worktreePath: "/tmp/a",
      status: "active",
      createdAt: "2026-04-17T00:00:00Z",
      updatedAt: "2026-04-17T00:00:00Z",
    };

    const b: FeatureRecord = {
      ...a,
      id: "feat-b",
      slug: "b",
      branch: "feat/b",
      worktreePath: "/tmp/b",
      updatedAt: "2026-04-17T01:00:00Z",
    };

    writeFeatureRecord(repoRoot, a);
    writeFeatureRecord(repoRoot, b);

    expect(listFeatureRecords(repoRoot).map((r) => r.id)).toEqual([
      "feat-b",
      "feat-a",
    ]);
  });
});
