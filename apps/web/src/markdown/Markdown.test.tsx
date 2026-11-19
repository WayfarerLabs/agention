import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BlockContent, Nodes, PhrasingContent, Root, RootContent } from "mdast";
import { collectDefinitions, Markdown, maxNesting, plainText } from "./Markdown.tsx";

afterEach(cleanup);

function renderMarkdown(text: string): HTMLElement {
  const { container } = render(<Markdown text={text} />);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error("nothing rendered");
  }
  return root;
}

const links = (root: HTMLElement) =>
  [...root.querySelectorAll("a")].map((a) => ({
    text: a.textContent,
    href: a.getAttribute("href"),
  }));

// Nothing the text holds may become markup that runs, loads or styles: every
// rendering is checked for these.
function expectInert(root: HTMLElement): void {
  expect(
    root.querySelectorAll("img, script, iframe, object, embed, style, svg, video, audio, form"),
  ).toHaveLength(0);
  for (const element of root.querySelectorAll("*")) {
    expect(element.hasAttribute("style")).toBe(false);
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.startsWith("on")).toBe(false);
    }
    if (element.hasAttribute("class")) {
      expect([
        "markdown",
        "raw",
        "plain",
        "host",
        "table",
        "task",
        "align-left",
        "align-center",
        "align-right",
      ]).toContain(element.getAttribute("class"));
    }
  }
  for (const anchor of root.querySelectorAll("a")) {
    expect(anchor.getAttribute("href")).toMatch(/^https:\/\//);
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(anchor.getAttribute("referrerpolicy")).toBe("no-referrer");
  }
}

describe("the hand check's body", () => {
  const body = [
    "```",
    "make check",
    "```",
    "",
    "| Step | State |",
    "| :--- | ---: |",
    "| build | done |",
    "",
    "- [x] built",
    "- [ ] shipped",
    "",
    "~~withdrawn~~",
    "",
    "[the pull request](https://example.com/pull/1) and [the old page](http://example.com/old)",
    "",
    "<b>bold?</b>",
    "",
    "![build graph](https://images.example/graph.png)",
  ].join("\n");

  it("renders formatting, one working link, and the rest as text", () => {
    const root = renderMarkdown(body);
    expectInert(root);
    expect(root.querySelector("pre > code")?.textContent).toBe("make check");
    expect([...root.querySelectorAll("th")].map((th) => [th.textContent, th.className])).toEqual([
      ["Step", "align-left"],
      ["State", "align-right"],
    ]);
    const boxes = [...root.querySelectorAll<HTMLInputElement>("li.task > input")];
    expect(boxes.map((box) => [box.type, box.checked, box.disabled])).toEqual([
      ["checkbox", true, true],
      ["checkbox", false, true],
    ]);
    expect(root.querySelector("del")?.textContent).toBe("withdrawn");
    expect(links(root)).toEqual([
      { text: "the pull request", href: "https://example.com/pull/1" },
      { text: "build graph", href: "https://images.example/graph.png" },
    ]);
    expect(root.textContent).toContain("the old page");
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("<b>bold?</b>");
  });
});

describe("links", () => {
  it.each([
    ["javascript:", "[x](javascript:alert(1))"],
    ["javascript: in upper case", "[x](JAVASCRIPT:alert(1))"],
    // cspell:disable-next-line
    ["data:", "[x](data:text/html;base64,PHNjcmlwdD4=)"],
    // cspell:disable-next-line
    ["an entity-obfuscated javascript:", "[x](&#106;avascript:alert(1))"],
    ["a hex entity in the scheme", "[x](jav&#x61;script:alert(1))"],
    ["a named entity in the scheme", "[x](javascript&colon;alert(1))"],
    ["plain http", "[x](http://example.com)"],
    ["a protocol-relative URL", "[x](//example.com)"],
    ["a relative path", "[x](/api/web/session)"],
    ["user information", "[x](https://user:secret@example.com/)"],
    ["a user name alone", "[x](https://user@example.com/)"],
    // cspell:disable-next-line
    ["a space in the URL", "[x](<https://exa mple.com>)"],
    ["a URL over 2,048 characters", `[x](https://example.com/${"a".repeat(2030)})`],
  ])("are text with %s", (_, text) => {
    const root = renderMarkdown(text);
    expectInert(root);
    expect(root.querySelectorAll("a")).toHaveLength(0);
    expect(root.textContent).toBe("x");
  });

  it("are live for an absolute https URL, linked as parsed", () => {
    const root = renderMarkdown(
      // cspell:disable-next-line
      "[a](HTTPS://Example.COM/a%20b?q=1#f) [b](&#104;ttps://example.com/)",
    );
    expectInert(root);
    expect(links(root)).toEqual([
      { text: "a", href: "https://example.com/a%20b?q=1#f" },
      { text: "b", href: "https://example.com/" },
    ]);
    expect(root.querySelector("a")?.getAttribute("target")).toBe("_blank");
  });

  it("follow the first definition of a reference", () => {
    const root = renderMarkdown(
      "[docs][d] and [bad][b]\n\n[d]: https://example.com/docs\n[d]: https://evil.example/\n[b]: javascript:alert(1)",
    );
    expectInert(root);
    expect(links(root)).toEqual([{ text: "docs", href: "https://example.com/docs" }]);
    expect(root.textContent).toBe("docs (example.com) and bad");
  });

  it.each([
    [
      "an https autolink",
      "<https://example.com/x>",
      [{ text: "https://example.com/x", href: "https://example.com/x" }],
    ],
    ["an http autolink", "<http://example.com/x>", []],
    ["a javascript autolink", "<javascript:alert(1)>", []],
    ["an email autolink", "<someone@example.com>", []],
    ["a bare URL", "see https://example.com/x", []],
    ["a www address", "see www.example.com", []],
  ])("render %s as allowed", (_, text, expected) => {
    const root = renderMarkdown(text);
    expectInert(root);
    expect(links(root)).toEqual(expected);
  });

  it("does not turn footnote syntax into links or ids", () => {
    const root = renderMarkdown("A claim.[^1]\n\n[^1]: The source.");
    expectInert(root);
    expect(root.querySelectorAll("a, [id]")).toHaveLength(0);
  });
});

describe("images", () => {
  it("are links labelled with their alt text, or their URL", () => {
    const root = renderMarkdown(
      "![a chart](https://example.com/c.png) ![](https://example.com/d.png)",
    );
    expectInert(root);
    expect(links(root)).toEqual([
      { text: "a chart", href: "https://example.com/c.png" },
      { text: "https://example.com/d.png", href: "https://example.com/d.png" },
    ]);
  });

  it("follow references the same way", () => {
    const root = renderMarkdown(
      "![logo][l] ![tracker][t] ![collapsed][]\n\n[l]: https://example.com/l.png\n[t]: http://tracker.example/p.gif\n[collapsed]: https://example.com/c.png",
    );
    expectInert(root);
    expect(links(root)).toEqual([
      { text: "logo", href: "https://example.com/l.png" },
      { text: "collapsed", href: "https://example.com/c.png" },
    ]);
    expect(root.textContent).toContain("tracker");
  });

  it("are text where the link rule refuses them", () => {
    const root = renderMarkdown(
      "![pixel](data:image/gif;base64,R0lGOD) ![](http://example.com/p.gif)",
    );
    expectInert(root);
    expect(root.querySelectorAll("a")).toHaveLength(0);
    expect(root.textContent).toBe("pixel http://example.com/p.gif");
  });

  it("inside a link are its text", () => {
    const root = renderMarkdown("[![badge](https://example.com/b.svg)](https://example.com/build)");
    expectInert(root);
    expect(links(root)).toEqual([{ text: "badge", href: "https://example.com/build" }]);
  });
});

describe("raw HTML", () => {
  it("is text inline", () => {
    const root = renderMarkdown(
      'Hello <img src="https://example.com/x.png" onerror="alert(1)"> there',
    );
    expectInert(root);
    expect(root.querySelector("p")?.textContent).toBe(
      'Hello <img src="https://example.com/x.png" onerror="alert(1)"> there',
    );
  });

  it("is a paragraph of text that keeps its line breaks as a block", () => {
    const html = '<div class="banner">\n<script>alert(1)</script>\n</div>';
    const root = renderMarkdown(html);
    expectInert(root);
    const block = root.querySelector("p.raw");
    expect(block?.textContent).toBe(html);
  });

  it("is text inside a list", () => {
    const root = renderMarkdown("- <iframe src=https://example.com></iframe>");
    expectInert(root);
    expect(root.querySelector("li")?.textContent).toBe("<iframe src=https://example.com></iframe>");
  });
});

describe("code", () => {
  it("takes no class from its info string", () => {
    const root = renderMarkdown(
      '```js class="evil" onload=alert(1)\nlet x = 1;\n```\n\n~~~language-x\ny\n~~~',
    );
    expectInert(root);
    for (const element of root.querySelectorAll("pre, code")) {
      expect(element.getAttributeNames()).toEqual([]);
    }
    expect([...root.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      "let x = 1;",
      "y",
    ]);
  });
});

describe("headings", () => {
  it("sit two levels below the page's heading and stop at six", () => {
    const root = renderMarkdown("# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six");
    expect([...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => h.tagName)).toEqual([
      "H3",
      "H4",
      "H5",
      "H6",
      "H6",
    ]);
  });
});

describe("text", () => {
  it("is shown exactly as written in text nodes", () => {
    const root = renderMarkdown("5 > 3 & 2 < 4, \"quoted\" and 'single'");
    expect(root.textContent).toBe("5 > 3 & 2 < 4, \"quoted\" and 'single'");
  });

  it("keeps tight lists free of paragraphs and loose ones with them", () => {
    const tight = renderMarkdown("- a\n- b");
    expect(tight.querySelectorAll("li > p")).toHaveLength(0);
    const loose = renderMarkdown("- a\n\n- b");
    expect(loose.querySelectorAll("li > p")).toHaveLength(2);
  });
});

describe("link targets", () => {
  const hosts = (root: HTMLElement) =>
    [...root.querySelectorAll("a")].map((a) => a.nextElementSibling?.textContent ?? null);

  it("follow a link whose text is not its own URL", () => {
    const root = renderMarkdown(
      [
        "[the pull request](https://example.com/pull/7)",
        "[https://example.com/safe](https://evil.example/)",
        "[x](https://example.com:8443/)",
        "![chart](https://images.example/c.png)",
      ].join(" "),
    );
    expectInert(root);
    expect(hosts(root)).toEqual([
      " (example.com)",
      " (evil.example)",
      " (example.com:8443)",
      " (images.example)",
    ]);
  });

  it("are left out when the link shows its own URL", () => {
    const root = renderMarkdown(
      "<https://example.com/x> ![](https://example.com/d.png) [https://example.com/y](https://example.com/y)",
    );
    expectInert(root);
    expect(root.querySelectorAll(".host")).toHaveLength(0);
  });

  it("show in browsers that lack URL.parse", () => {
    // The test environment's URL can inherit parse from the class it extends.
    const removed: [object, PropertyDescriptor][] = [];
    for (let owner: object | null = URL; owner !== null; owner = Object.getPrototypeOf(owner)) {
      const parse = Object.getOwnPropertyDescriptor(owner, "parse");
      if (parse !== undefined) {
        removed.push([owner, parse]);
        Reflect.deleteProperty(owner, "parse");
      }
    }
    try {
      expect("parse" in URL).toBe(false);
      const root = renderMarkdown("[the pull request](https://example.com/pull/7)");
      expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/pull/7");
      expect(hosts(root)).toEqual([" (example.com)"]);
    } finally {
      for (const [owner, parse] of removed) {
        Object.defineProperty(owner, "parse", parse);
      }
    }
  });
});

describe("text that could take the page down", () => {
  // Rendered as Markdown, each of these would exhaust the stack or take the
  // parser seconds.
  it.each([
    ["a line of 1,500 nested quotes", `${">".repeat(1500)}x`],
    ["a line of 4,000 nested list items", `${"- ".repeat(4000)}x`],
    ["a line of 9,000 nested list items", `${"- ".repeat(9000)}x`],
    ["a line of 33 nested quotes", `${">".repeat(33)} x`],
    ["a line of quotes and list items mixed", `${"> - ".repeat(17)}x`],
  ])("shows %s as its text", (_, text) => {
    const started = performance.now();
    const root = renderMarkdown(`Before\n${text}`);
    expect(performance.now() - started).toBeLessThan(1000);
    expectInert(root);
    expect(root.querySelectorAll("blockquote, li")).toHaveLength(0);
    expect(root.querySelector("p.plain")?.textContent).toBe(`Before\n${text}`);
  });

  it("renders 32 nested quotes on a line, with what is nested deeper as text", () => {
    const root = renderMarkdown(`${">".repeat(32)} innermost *text*`);
    expect(root.querySelectorAll("blockquote")).toHaveLength(32);
    expect(root.querySelector("em")).toBeNull();
    expect(root.textContent).toBe("innermost text");
  });

  it("stops descending where lines nest deeper than 32", () => {
    const text = Array.from({ length: 40 }, (_, level) => `${"  ".repeat(level)}- x${level}`).join(
      "\n",
    );
    const root = renderMarkdown(text);
    expect(root.querySelectorAll("li")).toHaveLength(16);
    expect(root.textContent).toContain("x39");
  });

  it("stops descending through deeply nested emphasis", () => {
    const root = renderMarkdown(`${"*".repeat(3000)}x${"*".repeat(3000)}`);
    expect(root.querySelector("p.plain")).toBeNull();
    const formatted = root.querySelectorAll("em, strong").length;
    expect(formatted).toBeGreaterThan(0);
    expect(formatted).toBeLessThanOrEqual(maxNesting);
    expect(root.textContent).toContain("x");
  });

  it("reads the text and definitions of a tree deeper than any stack", () => {
    // A tree no parse of a bounded text makes, to show neither walk recurses.
    let node: Nodes = { type: "text", value: "deepest" };
    for (let level = 0; level < 200_000; level++) {
      node = { type: "emphasis", children: [node as PhrasingContent] };
    }
    expect(plainText(node)).toBe("deepest");
    let block: Nodes = { type: "definition", identifier: "d", label: "d", url: "https://e.test/" };
    for (let level = 0; level < 200_000; level++) {
      block = { type: "blockquote", children: [block as BlockContent] };
    }
    const root: Root = { type: "root", children: [block as RootContent] };
    expect(collectDefinitions(root).get("d")).toBe("https://e.test/");
  });
});
