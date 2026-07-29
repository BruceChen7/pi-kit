import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const adaptersDir = path.join(
  process.cwd(),
  "extensions/visual-artifact/ui/src/renderer/adapters/layout",
);

describe("interactive nested layout adapters", () => {
  for (const filename of ["accordion.svelte", "tabs.svelte"]) {
    it(`${filename} imports the nested renderer it instantiates`, async () => {
      const source = await readFile(path.join(adaptersDir, filename), "utf8");

      expect(source).toContain(
        'import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";',
      );
      expect(source).toContain("<VisualArtifactRenderer");
    });
  }
});
