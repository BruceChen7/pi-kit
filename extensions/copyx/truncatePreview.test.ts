import { describe, expect, it } from "vitest";
import { PREVIEW_MAX_CHARS, truncatePreview } from "./types.js";

describe("truncatePreview", () => {
  describe("line limit", () => {
    it("should return all lines when total chars within limit", () => {
      const text = "第一行\n第二行\n第三行";
      const result = truncatePreview(text, 5, 200);
      expect(result).toBe("第一行\n第二行\n第三行");
    });

    it("should limit to maxLines even if chars within limit", () => {
      const text = "第一行\n第二行\n第三行\n第四行\n第五行";
      const result = truncatePreview(text, 2, 200);
      expect(result).toBe("第一行\n第二行\n...");
    });
  });

  describe("char limit", () => {
    it("should truncate last line when exceeding maxChars", () => {
      const text = `short\n${"a".repeat(80)}`;
      const result = truncatePreview(text, 5, 50);
      expect(result).toContain("...");
      expect(result.length).toBeLessThanOrEqual(50);
    });

    it("should add ellipsis when truncating", () => {
      const text = `x\n${"b".repeat(40)}`;
      const result = truncatePreview(text, 5, 10);
      expect(result).toContain("...");
    });

    it("should handle single line exceeding maxChars", () => {
      const text = "c".repeat(30);
      const result = truncatePreview(text, 5, 20);
      expect(result.length).toBeLessThanOrEqual(20);
      expect(result.endsWith("...")).toBe(true);
    });
  });

  describe("multi-line with char limit", () => {
    it("should show as many lines as possible within char limit", () => {
      const text = "第一行\n第二行\n第三行\n第四行\n第五行";
      const result = truncatePreview(text, 5, 15);
      // Ensure we keep as many full lines as possible while still reserving
      // room for truncation indicator and respecting maxChars exactly.
      expect(result).toBe("第一行\n第二行\n第三行\n...");
      expect(result.length).toBeLessThanOrEqual(15);
    });

    it("should prefer more lines over longer last line", () => {
      const text = "A\n这是一个很长的行超过了200个字符的限制需要被截断";
      const result = truncatePreview(text, 5, 20);
      // Should show "A" and truncate the long line
      expect(result).toContain("A");
      expect(result).toContain("...");
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      const result = truncatePreview("", 5, 200);
      expect(result).toBe("");
    });

    it("should handle string with only newlines", () => {
      const result = truncatePreview("\n\n\n", 5, 200);
      expect(result).toBe("\n\n");
    });

    it("should handle maxChars exactly", () => {
      const text = "12345678901234567890"; // 20 chars
      const result = truncatePreview(text, 5, 20);
      expect(result).toBe("12345678901234567890");
    });

    it("should handle maxChars less than 3", () => {
      const text = "hello";
      const result = truncatePreview(text, 5, 2);
      expect(result).toBe("..");
    });

    it("should use default values from types", () => {
      const text = "a".repeat(500);
      const result = truncatePreview(text);
      expect(result.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    });

    it("should count Chinese characters as one", () => {
      const chinese = "中";
      expect(chinese.length).toBe(1);

      const text = "你好世界这是一个很长的文本需要被截断";
      const result = truncatePreview(text, 5, 10);
      expect(result.length).toBeLessThanOrEqual(13); // 10 + "..."
    });
  });

  describe("real-world examples", () => {
    it("should truncate long assistant response", () => {
      const response = `Here's a comprehensive implementation:

\`\`\`typescript
interface User {
  id: number;
  name: string;
  email: string;
}

function createUser(user: User): User {
  return {
    ...user,
    createdAt: new Date(),
  };
}
\`\`\`

This implementation provides type safety and immutability.`;

      const result = truncatePreview(response, 5, 100);
      expect(result.length).toBeLessThanOrEqual(103);
      expect(result.endsWith("...")).toBe(true);
    });
  });
});
