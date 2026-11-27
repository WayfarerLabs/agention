import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown.tsx";

// The diagram component, drawn by a frame that answers as the tests say; the
// browser tests drive the real frame and the viewer.

const source = "flowchart LR\n  accTitle: Release flow\n  A --> B";

let created: string[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  // jsdom has no blob: URLs.
  Object.assign(URL, {
    createObjectURL: () => {
      created.push(`blob:diagram-${created.length + 1}`);
      return created.at(-1);
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
});

// The page's one frame stays for every test, as it would on a page.
afterEach(cleanup);

// answerNext answers the next request the page's frame is sent with what
// reply makes of it.
async function answerNext(reply: (id: number) => object): Promise<void> {
  const frame = document.querySelector("iframe");
  const window = frame?.contentWindow;
  if (frame === null || window === null || window === undefined) {
    throw new Error("the page holds no frame");
  }
  const sent = new Promise<{ id: number }>((resolve) =>
    vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
      resolve(message as { id: number });
    }),
  );
  frame.dispatchEvent(new Event("load"));
  const { id } = await sent;
  await act(async () => {
    globalThis.window.dispatchEvent(
      new MessageEvent("message", { data: reply(id), source: window }),
    );
  });
}

describe("a mermaid block", () => {
  it("shows as the image the frame drew, named and described by the diagram", async () => {
    render(<Markdown text={["```mermaid", source, "```"].join("\n")} />);
    expect(screen.queryByRole("img")).toBeNull();
    await answerNext((id) => ({
      id,
      svg: "<svg/>",
      title: "Release flow",
      description: "A goes to B.",
    }));

    // Its URL is revoked once it has loaded, so none is left to open.
    const image = screen.getByRole("img", { name: "Release flow" });
    expect(image.getAttribute("src")).toBe("blob:diagram-1");
    expect(revoked).toEqual([]);
    fireEvent.load(image);
    expect(revoked).toEqual(["blob:diagram-1"]);
    const opener = screen.getByRole("button", { name: "Release flow" });
    const description = document.getElementById(opener.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("A goes to B.");

    // Source shows the text it was drawn from, and hides it again.
    const toggle = screen.getByRole("button", { name: "Source" });
    expect(document.querySelector("pre")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("pre code")?.textContent).toBe(source);
    // The source is a code block, whose button copies it; the image has none.
    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(1);
    fireEvent.click(toggle);
    expect(document.querySelector("pre")).toBeNull();
  });

  it("is named Diagram when it declares no title, and revokes its URL as it goes unloaded", async () => {
    render(<Markdown text={["```mermaid", "flowchart LR\n  A --> B", "```"].join("\n")} />);
    await answerNext((id) => ({ id, svg: "<svg/>" }));
    expect(screen.getByRole("img", { name: "Diagram" })).toBeTruthy();
    expect(revoked).toEqual([]);
    cleanup();
    expect(revoked).toEqual(created);
  });

  it("shows its source when it cannot be drawn", async () => {
    render(<Markdown text={["```mermaid", "flowchart LR\n  A -->", "```"].join("\n")} />);
    await answerNext((id) => ({ id, error: "Parse error on line 2" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("pre code")?.textContent).toBe("flowchart LR\n  A -->");
  });

  it("is drawn only for the mermaid language", () => {
    render(<Markdown text={["```Mermaid", source, "```"].join("\n")} />);
    expect(document.querySelector("pre code")?.textContent).toBe(source);
    expect(document.querySelector("figure")).toBeNull();
  });
});
