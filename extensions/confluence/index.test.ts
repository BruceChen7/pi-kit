import { describe, expect, it, vi } from "vitest";
import { buildDisplaySearchEndpoint, extractPageIdFromSearch } from "./browser";
import {
  buildPageContext,
  decodeRestPage,
  parseConfluencePageId,
  parseDisplayReference,
  renderConfluencePageMarkdown,
  resolvePageReference,
} from "./context";
import {
  buildConfluencePagePrompt,
  type ConfluencePageReader,
  createConfluenceExtension,
} from "./index";

type FakeTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};
type FakeCommand = { handler: (...args: unknown[]) => Promise<void> | void };

function fakePi() {
  const tools = new Map<string, FakeTool>();
  const commands = new Map<string, FakeCommand>();
  return {
    tools,
    commands,
    registerTool(tool: FakeTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: FakeCommand) {
      commands.set(name, command);
    },
    sendUserMessage: vi.fn(),
  };
}

describe("internal Confluence context", () => {
  it("parses Server/Data Center page URLs", () => {
    expect(
      parseConfluencePageId(
        "https://confluence.example.test/pages/viewpage.action?pageId=123456789",
      ),
    ).toBe("123456789");
    expect(parseConfluencePageId("123456789")).toBe("123456789");
  });

  it("parses display URLs into space key and title", () => {
    expect(
      parseDisplayReference(
        "https://confluence.example.test/display/SPPT/%5BExternal%5D+Voucher+Core+Seller+Voucher+API+Migration+Guide",
      ),
    ).toEqual({
      spaceKey: "SPPT",
      title: "[External] Voucher Core Seller Voucher API Migration Guide",
    });
    expect(
      parseDisplayReference(
        "https://confluence.example.test/pages/viewpage.action?pageId=123",
      ),
    ).toBeNull();
  });

  it("resolves display URLs without a page ID", () => {
    const reference = resolvePageReference("https://confluence.example.test", {
      url: "https://confluence.example.test/display/SPPT/My+Page+Title",
    });
    expect(reference.pageId).toBeUndefined();
    expect(reference.url).toBe(
      "https://confluence.example.test/display/SPPT/My+Page+Title",
    );
    expect(reference.display).toEqual({
      spaceKey: "SPPT",
      title: "My Page Title",
    });
  });

  it("rejects URLs outside the configured Confluence origin", () => {
    expect(() =>
      resolvePageReference("https://confluence.example.test", {
        url: "https://evil.example.test/pages/viewpage.action?pageId=123",
      }),
    ).toThrow("configured internal Confluence host");
  });

  it("builds Markdown context from a validated REST DTO", () => {
    const page = buildPageContext(
      decodeRestPage({
        id: "123456789",
        title: "Internal Guide",
        space: { id: "484081666" },
        version: { number: 6, when: "2026-08-18T00:00:00Z" },
        body: {
          storage: {
            value:
              '<h1>Heading</h1><p>ABC-123 <a href="https://figma.com/file/abc">design</a></p>',
          },
        },
        _links: {
          base: "https://confluence.example.test",
          webui: "/pages/viewpage.action?pageId=123456789",
        },
      }),
      "https://confluence.example.test/pages/viewpage.action?pageId=123456789",
    );
    expect(page.headings).toEqual(["Heading"]);
    expect(page.links.jiraKeys).toEqual(["ABC-123"]);
    expect(page.links.figmaUrls).toEqual(["https://figma.com/file/abc"]);
    expect(renderConfluencePageMarkdown(page)).toContain("Internal Guide");
  });
});

describe("display URL → page id resolution (pure helpers)", () => {
  it("builds a spaceKey/title search endpoint", () => {
    expect(
      buildDisplaySearchEndpoint({ spaceKey: "SPPT", title: "My Page Title" }),
    ).toBe("/rest/api/content?spaceKey=SPPT&title=My%20Page%20Title");
  });

  it("URL-encodes plus signs and special characters in the title", () => {
    expect(
      buildDisplaySearchEndpoint({ spaceKey: "SPPT", title: "A+B & C" }),
    ).toBe("/rest/api/content?spaceKey=SPPT&title=A%2BB%20%26%20C");
  });

  it("extracts the first page id from a search response", () => {
    expect(
      extractPageIdFromSearch({ results: [{ id: "42" }, { id: "99" }] }),
    ).toBe("42");
  });

  it("returns null when no result carries an id", () => {
    expect(extractPageIdFromSearch({ results: [] })).toBeNull();
    expect(extractPageIdFromSearch({ results: [{}] })).toBeNull();
    expect(extractPageIdFromSearch({})).toBeNull();
    expect(extractPageIdFromSearch(null)).toBeNull();
  });
});

describe("Confluence page tool", () => {
  it("returns page context through the public tool interface", async () => {
    const reader: ConfluencePageReader = {
      read: vi.fn(async () => ({
        id: "123",
        title: "Guide",
        url: "https://confluence.example.test/pages/viewpage.action?pageId=123",
        markdown: "# Guide",
        headings: ["Guide"],
        links: { urls: [], figmaUrls: [], jiraKeys: [] },
      })),
    };
    const pi = fakePi();
    createConfluenceExtension({
      readBaseUrl: () => "https://confluence.example.test",
      reader,
    })(pi as never);
    const result = await pi.tools
      .get("confluence_page")
      .execute("call-1", { pageId: "123" });
    expect(reader.read).toHaveBeenCalled();
    const numericCall = (reader.read as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(numericCall?.[0]).toBe(
      "https://confluence.example.test/pages/viewpage.action?pageId=123",
    );
    expect(numericCall?.[1]).toBe("123");
    expect((result as { details: unknown }).details).toMatchObject({
      id: "123",
      title: "Guide",
    });
    expect(
      (result as { content: Array<{ text: string }> }).content[0].text,
    ).toContain("# Guide");
  });

  it("does not register tools or commands without a base URL", () => {
    const pi = fakePi();
    createConfluenceExtension({ readBaseUrl: () => undefined })(pi as never);
    expect(pi.tools.size).toBe(0);
    expect(pi.commands.size).toBe(0);
  });

  it("builds the command prompt from a page reference", () => {
    expect(buildConfluencePagePrompt("123")).toBe(
      'Use confluence_page to fetch Confluence page with pageId: "123"',
    );
  });

  it("routes a display URL through the reader without a page ID", async () => {
    const reader: ConfluencePageReader = {
      read: vi.fn(async (_url, _pageId) => ({
        id: "987",
        title: "Guide",
        url: "https://confluence.example.test/display/SPPT/Guide",
        markdown: "# Guide",
        headings: ["Guide"],
        links: { urls: [], figmaUrls: [], jiraKeys: [] },
      })),
    };
    const pi = fakePi();
    createConfluenceExtension({
      readBaseUrl: () => "https://confluence.example.test",
      reader,
    })(pi as never);
    const result = await pi.tools.get("confluence_page").execute("call-2", {
      url: "https://confluence.example.test/display/SPPT/Guide",
    });
    expect(reader.read).toHaveBeenCalled();
    expect((reader.read as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "https://confluence.example.test/display/SPPT/Guide",
    );
    expect((result as { details: unknown }).details).toMatchObject({
      id: "987",
      title: "Guide",
    });
  });
});
