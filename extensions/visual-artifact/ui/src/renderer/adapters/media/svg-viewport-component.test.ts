import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const componentPath = path.join(
  process.cwd(),
  "extensions/visual-artifact/ui/src/renderer/adapters/media/SvgViewport.svelte",
);

describe("SvgViewport diagram mount", () => {
  it("scopes SVG lookup away from toolbar icons", async () => {
    const source = await readFile(componentPath, "utf8");

    expect(source).toContain("bind:this={svgContentEl}");
    expect(source).toContain('svgContentEl?.querySelector("svg")');
    expect(source).not.toContain('containerEl.querySelector("svg")');
    expect(source).not.toContain('el.querySelector("svg")');
  });

  it("keeps inline diagram viewports column-width aligned", async () => {
    const source = await readFile(componentPath, "utf8");

    expect(source).toContain("relative w-full cursor-grab");
    expect(source).not.toContain("width: min(100%,");
  });

  it("top-aligns fitted diagrams via the shared constant", async () => {
    const source = await readFile(componentPath, "utf8");

    expect(source).toContain(
      'setAttribute("preserveAspectRatio", FIT_PRESERVE_ASPECT_RATIO)',
    );
  });
});
