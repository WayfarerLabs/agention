import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown.tsx";

// A field whose text fails to render: the parser throws for text holding
// "BREAK".
vi.mock(import("mdast-util-from-markdown"), async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    fromMarkdown: ((text: string, options: Parameters<typeof real.fromMarkdown>[1]) => {
      if (text.includes("BREAK")) {
        throw new RangeError("Maximum call stack size exceeded");
      }
      return real.fromMarkdown(text, options);
    }) as typeof real.fromMarkdown,
  };
});

afterEach(cleanup);

it("falls back to the text of a field that fails to render, leaving the others standing", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { container } = render(
    <>
      <Markdown text={"BREAK *this*\nsecond line"} />
      <Markdown text="*fine*" />
    </>,
  );
  const [broken, fine] = container.querySelectorAll(".markdown");
  expect(broken?.querySelector("p.plain")?.textContent).toBe("BREAK *this*\nsecond line");
  expect(fine?.querySelector("em")?.textContent).toBe("fine");
});
