import { describe, expect, it } from "vitest";
import { defaultReviewTargetKindFromRelativePath } from "./review-targets.js";

describe("defaultReviewTargetKindFromRelativePath", () => {
  it("subsumes the well-known review locations under the broad rule", () => {
    expect(
      defaultReviewTargetKindFromRelativePath(
        ".pi/plans/repo/plan/2026-04-15-auth-flow.md",
      ),
    ).toBe("plan");
    expect(
      defaultReviewTargetKindFromRelativePath(
        ".pi/plans/repo/specs/2026-04-20-auth-design.md",
      ),
    ).toBe("plan");
    expect(
      defaultReviewTargetKindFromRelativePath(
        ".pi/plans/repo/shaping/current-notes.md",
      ),
    ).toBe("plan");
    expect(
      defaultReviewTargetKindFromRelativePath(
        ".pi/plans/repo/issues/topic/01-cleanup.md",
      ),
    ).toBe("plan");
  });

  it("treats any .md file under .pi/ as a review target", () => {
    expect(defaultReviewTargetKindFromRelativePath(".pi/notes.md")).toBe(
      "plan",
    );
    expect(
      defaultReviewTargetKindFromRelativePath(".pi/plans/repo/plan/notes.md"),
    ).toBe("plan");
    expect(
      defaultReviewTargetKindFromRelativePath(
        ".pi/plans/repo/issues/01-root-issue.md",
      ),
    ).toBe("plan");
    expect(
      defaultReviewTargetKindFromRelativePath(
        ".pi/plans/repo/issues/topic/nested/01-cleanup.md",
      ),
    ).toBe("plan");
    expect(defaultReviewTargetKindFromRelativePath(".pi/a/b/c/notes.md")).toBe(
      "plan",
    );
  });

  it("treats any .html file under .pi/ as a review target", () => {
    expect(defaultReviewTargetKindFromRelativePath(".pi/proto.html")).toBe(
      "plan",
    );
    expect(
      defaultReviewTargetKindFromRelativePath(".pi/html/repo/proto.html"),
    ).toBe("plan");
    expect(
      defaultReviewTargetKindFromRelativePath(
        ".pi/plans/repo/plan/2026-04-15-auth-flow.html",
      ),
    ).toBe("plan");
    expect(
      defaultReviewTargetKindFromRelativePath(
        ".pi/plans/repo/specs/2026-04-20-auth-design.html",
      ),
    ).toBe("plan");
  });

  it("is case-insensitive about the extension", () => {
    expect(defaultReviewTargetKindFromRelativePath(".pi/NOTES.MD")).toBe(
      "plan",
    );
    expect(defaultReviewTargetKindFromRelativePath(".pi/PAGE.HTML")).toBe(
      "plan",
    );
  });

  it("rejects non-review files", () => {
    expect(defaultReviewTargetKindFromRelativePath(".pi/notes.txt")).toBeNull();
    expect(defaultReviewTargetKindFromRelativePath(".pi")).toBeNull();
    expect(defaultReviewTargetKindFromRelativePath(".pi/plans")).toBeNull();
    expect(
      defaultReviewTargetKindFromRelativePath(".pi/plans/repo"),
    ).toBeNull();
    expect(defaultReviewTargetKindFromRelativePath("src/notes.md")).toBeNull();
    expect(
      defaultReviewTargetKindFromRelativePath("docs/proto.html"),
    ).toBeNull();
    expect(
      defaultReviewTargetKindFromRelativePath("foo/.pi/notes.md"),
    ).toBeNull();
  });
});
