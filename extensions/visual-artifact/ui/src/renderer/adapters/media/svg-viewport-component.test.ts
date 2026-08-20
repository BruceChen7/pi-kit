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

  it("reserves space so floating controls do not cover diagram content", async () => {
    // Shell patch protection: SvgViewport.svelte is intentionally not
    // mounted in tests (vitest's svelte-stub plugin returns {} for .svelte),
    // so DOM behavior cannot be asserted directly here. The pure fit/geometry
    // contract lives in svg-viewport.ts and is covered by svg-viewport.test.ts
    // (fitBoundsToContainer and friends). These source assertions only guard
    // the shell's two DOM decisions against accidental regression:
    // 1) measure the fit against the SVG mount rather than the outer card,
    //    because the mount reserves the toolbar-safe gutter (pr-14);
    // 2) keep that gutter on the mount wrapper.
    const source = await readFile(componentPath, "utf8");

    expect(source).toContain('class="h-full w-full box-border pr-14"');
    expect(source).toContain("const rect = svgEl.getBoundingClientRect()");
  });
});
