// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

const { canSanitize, renderMarkdown, renderMarkdownHtml } = await import("./render");

const DOC_DIR = "D:\\notes\\my docs";

describe("source line attributes", () => {
  const html = renderMarkdownHtml("# Title\n\npara one\n\n- a\n- b\n\n```ts\nlet x = 1;\n```\n\n> quote\n\n---\n");

  it("marks headings, paragraphs, lists, code, quotes and rules with their 0-based start line", () => {
    expect(html).toContain('<h1 data-source-line="0">');
    expect(html).toContain('<p data-source-line="2">');
    expect(html).toContain('<ul data-source-line="4">');
    expect(html).toContain('<li data-source-line="4">');
    expect(html).toContain('<li data-source-line="5">');
    expect(html).toContain('<pre data-source-line="7">');
    expect(html).toContain('<blockquote data-source-line="11">');
    expect(html).toContain('<hr data-source-line="13">');
  });

  it("does not leak the attribute into inline content", () => {
    expect(renderMarkdownHtml("some *text*")).toBe('<p data-source-line="0">some <em>text</em></p>\n');
  });
});

describe("fenced code", () => {
  it("renders escaped code with data-lang and language class", () => {
    const html = renderMarkdownHtml("```ts\nif (a < b && c) {}\n```");
    expect(html).toContain('<code class="language-ts" data-lang="ts">if (a &lt; b &amp;&amp; c) {}\n</code>');
  });

  it("takes only the first word of the info string", () => {
    expect(renderMarkdownHtml("```js title=x\n1\n```")).toContain('data-lang="js"');
  });

  it("emits no language attributes without an info string or with a hostile one", () => {
    expect(renderMarkdownHtml("```\nplain\n```")).toContain("<code>plain\n</code>");
    const hostile = renderMarkdownHtml('```"><img src=x onerror=alert(1)>\ncode\n```');
    expect(hostile).not.toContain("data-lang");
    expect(hostile).not.toContain("<img");
  });
});

describe("links", () => {
  it("does not emit a javascript: link from markdown syntax", () => {
    const html = renderMarkdownHtml("[x](javascript:alert(1))");
    expect(html).not.toContain("href");
  });

  it("linkifies bare URLs", () => {
    expect(renderMarkdownHtml("see https://example.com now")).toContain('<a href="https://example.com">');
  });
});

describe("relative images", () => {
  it("resolves against the document directory, decoding spaces", () => {
    const html = renderMarkdownHtml("![a](img/pic%20one.png)", { docDir: DOC_DIR });
    expect(html).toContain(`src="asset://localhost/${encodeURIComponent("D:\\notes\\my docs\\img\\pic one.png")}"`);
  });

  it("handles .. and ./ segments", () => {
    const html = renderMarkdownHtml("![a](<../shared pics/./x y.png>)", { docDir: DOC_DIR });
    expect(html).toContain(encodeURIComponent("D:\\notes\\shared pics\\x y.png"));
  });

  it("strips query and hash from the file reference", () => {
    const html = renderMarkdownHtml("![a](a.png?raw=1#frag)", { docDir: DOC_DIR });
    expect(html).toContain(encodeURIComponent("D:\\notes\\my docs\\a.png"));
  });

  it("keeps POSIX separators for POSIX directories", () => {
    const html = renderMarkdownHtml("![a](../b.png)", { docDir: "/home/u/docs" });
    expect(html).toContain(encodeURIComponent("/home/u/b.png"));
  });

  it("leaves remote and data images alone", () => {
    const html = renderMarkdownHtml("![a](https://example.com/a.png) ![b](data:image/png;base64,AAAA)", { docDir: DOC_DIR });
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it("leaves relative images unresolved without a directory (Untitled tab)", () => {
    expect(renderMarkdownHtml("![a](img/p.png)", { docDir: null })).toContain('src="img/p.png"');
  });
});

// DOMPurify needs a DOM. Under Node these are skipped here and exercised in a real browser
// (see the preview report); add jsdom as a devDependency to run them in vitest.
describe.skipIf(!canSanitize())("sanitization", () => {
  it("strips script tags and event handlers", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n<p onclick="x()">hi</p>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).toContain("hi");
  });

  it("strips iframes and javascript: hrefs from raw HTML", () => {
    const html = renderMarkdown('<iframe src="https://example.com"></iframe>\n\n<a href="javascript:alert(1)">x</a>');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("javascript:");
  });

  it("keeps data-source-line", () => {
    expect(renderMarkdown("# T")).toContain('data-source-line="0"');
  });

  it("rewrites relative raw <img> sources", () => {
    expect(renderMarkdown('<img src="a b.png">', { docDir: DOC_DIR })).toContain(encodeURIComponent("D:\\notes\\my docs\\a b.png"));
  });
});

describe("renderMarkdown without a DOM", () => {
  it.skipIf(canSanitize())("refuses to return unsanitized HTML", () => {
    expect(() => renderMarkdown("# x")).toThrow(/sanitizer unavailable/);
  });
});
