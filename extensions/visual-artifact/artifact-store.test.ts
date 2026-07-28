import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteArtifact,
  listArtifacts,
  listProjects,
  readArtifact,
  writeArtifact,
} from "./artifact-store.ts";
import { getArtifactJsonPath } from "./paths.ts";

const TEST_ROOT = path.join(process.cwd(), ".test-tmp", "artifact-store-test");
const TEST_PROJECT = "test-project";
const TEST_SLUG = "test-artifact";

const sampleSpec = {
  slug: TEST_SLUG,
  title: "Test Artifact",
  description: "For testing.",
  nodes: [{ type: "text", props: { text: "Hello.", size: "md" } }],
};

const sampleSpec2 = {
  slug: "artifact-2",
  title: "Artifact Two",
  nodes: [{ type: "text", props: { text: "Second.", size: "sm" } }],
};

describe("artifact-store", () => {
  beforeEach(() => {
    // Clean up before each test
    deleteArtifact(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    deleteArtifact(TEST_ROOT, TEST_PROJECT, "artifact-2");
    deleteArtifact(TEST_ROOT, TEST_PROJECT, "legacy-mermaid");
  });

  afterEach(() => {
    deleteArtifact(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    deleteArtifact(TEST_ROOT, TEST_PROJECT, "artifact-2");
    deleteArtifact(TEST_ROOT, TEST_PROJECT, "legacy-mermaid");
  });

  it("writes and reads an artifact", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec as never);
    const read = readArtifact(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    expect(read).not.toBeNull();
    expect(read?.slug).toBe(TEST_SLUG);
    expect(read?.title).toBe("Test Artifact");
  });

  it("returns null for non-existent artifact", () => {
    const read = readArtifact(TEST_ROOT, TEST_PROJECT, "does-not-exist");
    expect(read).toBeNull();
  });

  it("normalizes legacy mermaid syntax when reading an artifact", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, {
      slug: "legacy-mermaid",
      title: "Legacy Mermaid",
      nodes: [
        {
          type: "mermaid",
          props: {
            code: [
              "graph TD",
              "UPDATE_UI --> |todo widget| SHOW_TODO[#id [✓/~/!] text",
              "progress bar]",
            ].join("\n"),
          },
        },
      ],
    } as never);

    const read = readArtifact(TEST_ROOT, TEST_PROJECT, "legacy-mermaid");
    const code = read?.nodes[0]?.props.code;

    expect(typeof code).toBe("string");
    expect(String(code)).toContain(
      'SHOW_TODO["#id [✓/~/!] text<br/>progress bar"]',
    );

    deleteArtifact(TEST_ROOT, TEST_PROJECT, "legacy-mermaid");
  });

  it("writes atomically (file exists after write)", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec as never);
    const targetPath = getArtifactJsonPath(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    expect(existsSync(targetPath)).toBe(true);

    const content = JSON.parse(readFileSync(targetPath, "utf8"));
    expect(content.slug).toBe(TEST_SLUG);
  });

  it("lists projects", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec as never);
    const projects = listProjects(TEST_ROOT);
    expect(projects).toContain(TEST_PROJECT);
  });

  it("lists artifacts in a project", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec as never);
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec2 as never);

    const artifacts = listArtifacts(TEST_ROOT, TEST_PROJECT);
    expect(artifacts).toHaveLength(2);
    const slugs = artifacts.map((a) => a.slug).sort();
    expect(slugs).toEqual(["artifact-2", TEST_SLUG]);
  });

  it("deletes an artifact", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec as never);
    deleteArtifact(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    const read = readArtifact(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    expect(read).toBeNull();
  });

  it("handles empty project listing", () => {
    const projects = listProjects(TEST_ROOT);
    expect(Array.isArray(projects)).toBe(true);
  });

  it("handles empty artifact listing", () => {
    const artifacts = listArtifacts(TEST_ROOT, TEST_PROJECT);
    expect(artifacts).toEqual([]);
  });
});
