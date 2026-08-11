import { describe, expect, it } from "vitest";
import { isHtmlArtifactPathIn, resolveHtmlArtifactDirs } from "./html-dirs.js";

describe("resolveHtmlArtifactDirs", () => {
  it("resolves the convention .pi/html/<repo> dir (cwd basename fallback)", () => {
    expect(resolveHtmlArtifactDirs("/repo")).toContain("/repo/.pi/html/repo");
  });

  it("is not configurable — no settings are read", () => {
    // HTML review locations are convention-based; the result must not
    // depend on any plannotatorAuto.htmlDirs setting.
    expect(resolveHtmlArtifactDirs("/repo")).toEqual(["/repo/.pi/html/repo"]);
  });
});

describe("isHtmlArtifactPathIn", () => {
  it("matches dated HTML files under the given dirs", () => {
    expect(
      isHtmlArtifactPathIn(
        resolveHtmlArtifactDirs("/repo"),
        "/repo/.pi/html/repo/2026-08-05-proto.html",
      ),
    ).toBe(true);
  });

  it("rejects non-dated filenames", () => {
    expect(
      isHtmlArtifactPathIn(
        resolveHtmlArtifactDirs("/repo"),
        "/repo/.pi/html/repo/proto.html",
      ),
    ).toBe(false);
  });

  it("rejects non-HTML files", () => {
    expect(
      isHtmlArtifactPathIn(
        resolveHtmlArtifactDirs("/repo"),
        "/repo/.pi/html/repo/2026-08-05-proto.md",
      ),
    ).toBe(false);
  });

  it("rejects files outside the html dirs", () => {
    expect(
      isHtmlArtifactPathIn(
        resolveHtmlArtifactDirs("/repo"),
        "/repo/.pi/plans/repo/plan/2026-08-05-x.html",
      ),
    ).toBe(false);
  });
});
