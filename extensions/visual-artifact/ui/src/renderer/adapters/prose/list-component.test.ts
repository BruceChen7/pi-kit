import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const componentPath = path.join(
  process.cwd(),
  "extensions/visual-artifact/ui/src/renderer/adapters/prose/list.svelte",
);

describe("ListAdapter", () => {
  it("restores markers removed by Tailwind preflight", async () => {
    const source = await readFile(componentPath, "utf8");

    expect(source).toContain("list-disc");
    expect(source).toContain("list-decimal");
    expect(source).toContain("marker:text-clay");
  });
});
