import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVisualArtifactHtml } from "./ui-html.ts";

describe("createVisualArtifactHtml", () => {
  it("produces self-contained html without runtime chunk URLs", async () => {
    const html = await createVisualArtifactHtml({
      bootData: {
        view: "artifact",
        projectName: "pi-kit",
        artifactSlug: "self-contained",
        artifactSpec: {
          slug: "self-contained",
          title: "Self contained",
          nodes: [
            {
              type: "mermaid",
              props: {
                code: "flowchart LR\n  A --> B",
              },
            },
          ],
        },
      },
    });

    expect(html).not.toMatch(/import\(["'](?:\/assets\/|\.\/)[^"']+\.js["']\)/);
  });

  it("escapes closing tags inside inlined js bundles and injects boot data at the real head close", async () => {
    const uiDistDir = await mkdtemp(join(tmpdir(), "va-ui-dist-"));

    await writeFile(
      join(uiDistDir, "index.html"),
      [
        "<!doctype html>",
        '<html><head><script type="module" src="/assets/index.js"></script></head>',
        '<body><div id="app"></div></body></html>',
      ].join(""),
      "utf8",
    );

    await mkdir(join(uiDistDir, "assets"), { recursive: true });
    await writeFile(
      join(uiDistDir, "assets/index.js"),
      [
        'const badScript = "</script><div id=\\"oops\\">";',
        'const badHead = "</head><body>broken";',
        'const badBody = "</body></html>broken";',
        "console.log(badScript, badHead, badBody);",
      ].join("\n"),
      "utf8",
    );

    const html = await createVisualArtifactHtml({
      uiDistDir,
      bootData: { view: "home" },
    });

    expect(html).toContain('<\\/script><div id=\\"oops\\">');
    expect(html).toContain("<\\/head><body>broken");
    expect(html).toContain("<\\/body></html>broken");
    expect(html).not.toContain('</script><div id=\\"oops\\">');

    const bootMarker = "window.__VISUAL_ARTIFACT_BOOT__";
    expect(html.lastIndexOf(bootMarker)).toBeGreaterThan(
      html.indexOf("console.log"),
    );
    expect(html.lastIndexOf(bootMarker)).toBeLessThan(
      html.lastIndexOf("</head>"),
    );
  });
});
