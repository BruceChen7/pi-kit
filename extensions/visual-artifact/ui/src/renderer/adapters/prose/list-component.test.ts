import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { listMarkerClasses } from "./list.ts";

describe("listMarkerClasses", () => {
  it("returns list-decimal for ordered lists", () => {
    expect(listMarkerClasses(true)).toBe("list-decimal");
  });

  it("returns list-disc for unordered lists", () => {
    expect(listMarkerClasses(false)).toBe("list-disc");
  });
});

describe("ListAdapter component", () => {
  it("applies the marker classes through the shared helper", async () => {
    const source = await readFile(
      path.join(
        process.cwd(),
        "extensions/visual-artifact/ui/src/renderer/adapters/prose/list.svelte",
      ),
      "utf8",
    );

    expect(source).toContain("{listMarkerClasses(");
  });
});
