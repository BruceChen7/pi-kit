import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VisualArtifactSpec } from "./artifact-schema.ts";
import {
  cleanAll,
  cleanProject,
  deleteArtifact,
  listArtifacts,
  listProjects,
  readArtifact,
  summarizeNodes,
  writeArtifact,
} from "./artifact-store.ts";
import { getArtifactJsonPath } from "./paths.ts";

const TEST_ROOT = path.join(process.cwd(), ".test-tmp", "artifact-store-test");
const TEST_PROJECT = "test-project";
const SECOND_PROJECT = "second-project";
const TEST_SLUG = "test-artifact";

const sampleSpec: VisualArtifactSpec = {
  slug: TEST_SLUG,
  title: "Test Artifact",
  description: "For testing.",
  nodes: [{ type: "text", props: { text: "Hello.", size: "md" } }],
};

const sampleSpec2: VisualArtifactSpec = {
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
    deleteArtifact(TEST_ROOT, TEST_PROJECT, "typed-artifact");
    deleteArtifact(TEST_ROOT, SECOND_PROJECT, TEST_SLUG);
  });

  afterEach(() => {
    deleteArtifact(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    deleteArtifact(TEST_ROOT, TEST_PROJECT, "artifact-2");
    deleteArtifact(TEST_ROOT, TEST_PROJECT, "legacy-mermaid");
    deleteArtifact(TEST_ROOT, TEST_PROJECT, "typed-artifact");
    deleteArtifact(TEST_ROOT, SECOND_PROJECT, TEST_SLUG);
  });

  it("writes and reads an artifact", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec);
    const read = readArtifact(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    expect(read).not.toBeNull();
    expect(read?.slug).toBe(TEST_SLUG);
    expect(read?.title).toBe("Test Artifact");
  });

  it("returns null for non-existent artifact", () => {
    const read = readArtifact(TEST_ROOT, TEST_PROJECT, "does-not-exist");
    expect(read).toBeNull();
  });

  it("reads artifacts without rewriting mermaid code (no silent normalize)", () => {
    const legacySpec: VisualArtifactSpec = {
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
    };
    writeArtifact(TEST_ROOT, TEST_PROJECT, legacySpec);

    const read = readArtifact(TEST_ROOT, TEST_PROJECT, "legacy-mermaid");
    const code = read?.nodes[0]?.props.code;

    expect(typeof code).toBe("string");
    // The stored code is returned verbatim — validation (not rewriting) is
    // the project policy; agents fix invalid syntax themselves.
    expect(String(code)).toContain("SHOW_TODO[#id [✓/~/!] text");
    expect(String(code)).toContain("progress bar]");

    deleteArtifact(TEST_ROOT, TEST_PROJECT, "legacy-mermaid");
  });

  it("writes atomically (file exists after write)", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec);
    const targetPath = getArtifactJsonPath(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    expect(existsSync(targetPath)).toBe(true);

    const content = JSON.parse(readFileSync(targetPath, "utf8"));
    expect(content.slug).toBe(TEST_SLUG);
  });

  it("lists projects", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec);
    const projects = listProjects(TEST_ROOT);
    expect(projects).toContain(TEST_PROJECT);
  });

  it("lists artifacts in a project", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec);
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec2);

    const artifacts = listArtifacts(TEST_ROOT, TEST_PROJECT);
    expect(artifacts).toHaveLength(2);
    const slugs = artifacts.map((a) => a.slug).sort();
    expect(slugs).toEqual(["artifact-2", TEST_SLUG]);
  });

  it("summarizes nodes for the artifact list (count + unique types)", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, {
      slug: "typed-artifact",
      title: "Typed Artifact",
      nodes: [
        { type: "heading", props: { text: "H", level: "h1" } },
        { type: "mermaid", props: { definition: "flowchart LR\n A --> B" } },
        { type: "text", props: { text: "body" } },
        { type: "mermaid", props: { definition: "flowchart LR\n B --> C" } },
        { type: "kpi-grid", props: { columns: 2, items: [] } },
      ],
    });

    const artifacts = listArtifacts(TEST_ROOT, TEST_PROJECT);
    const summary = artifacts.find((a) => a.slug === "typed-artifact");

    expect(summary?.nodeCount).toBe(5);
    expect(summary?.nodeTypes).toEqual([
      "heading",
      "mermaid",
      "text",
      "kpi-grid",
    ]);
  });

  it("caps node types in the summary at a display limit", () => {
    const types = Array.from({ length: 10 }, (_, i) => `type-${i}`);
    const summary = summarizeNodes({
      nodes: types.map((type) => ({ type, props: {} })),
    });
    expect(summary.nodeCount).toBe(10);
    expect(summary.nodeTypes).toHaveLength(6);
    expect(summary.nodeTypes[0]).toBe("type-0");
  });

  it("deletes an artifact", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec);
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

  /* ---- cleanProject / cleanAll ---- */

  it("cleanProject removes all artifacts in a project", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec);
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec2);

    cleanProject(TEST_ROOT, TEST_PROJECT);

    const artifacts = listArtifacts(TEST_ROOT, TEST_PROJECT);
    expect(artifacts).toEqual([]);
  });

  it("cleanAll removes all artifacts across all projects", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec);
    writeArtifact(TEST_ROOT, SECOND_PROJECT, sampleSpec);

    cleanAll(TEST_ROOT);

    expect(listProjects(TEST_ROOT)).not.toContain(TEST_PROJECT);
    expect(listProjects(TEST_ROOT)).not.toContain(SECOND_PROJECT);
  });

  it("cleanProject on non-existent project does not throw", () => {
    expect(() => cleanProject(TEST_ROOT, "does-not-exist")).not.toThrow();
  });

  it("cleanAll on empty root does not throw", () => {
    // Ensure empty
    cleanAll(TEST_ROOT);
    expect(() => cleanAll(TEST_ROOT)).not.toThrow();
  });

  it("cleanProject only removes the specified project", () => {
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec);
    writeArtifact(TEST_ROOT, SECOND_PROJECT, sampleSpec);

    cleanProject(TEST_ROOT, TEST_PROJECT);

    // First project should be gone
    expect(listProjects(TEST_ROOT)).not.toContain(TEST_PROJECT);
    // Second project should remain
    expect(listProjects(TEST_ROOT)).toContain(SECOND_PROJECT);
  });
});
