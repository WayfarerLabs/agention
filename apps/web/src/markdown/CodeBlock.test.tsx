import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maxDiagramSource } from "../diagram-frame/protocol.ts";
import { Markdown } from "./Markdown.tsx";

// clipboard stands in for the browser's clipboard, landing each write or
// refusing them all.
function clipboard(refuse = false) {
  const writeText = vi.fn((_text: string) =>
    refuse ? Promise.reject(new DOMException("denied", "NotAllowedError")) : Promise.resolve(),
  );
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

const copyButtons = () => screen.getAllByRole<HTMLButtonElement>("button", { name: "Copy code" });
// What a block's live region says, empty while it says nothing.
const confirmation = (button: HTMLElement) =>
  button.parentElement?.querySelector("[aria-live]")?.textContent ?? "";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("a code block's copy button", () => {
  it("copies exactly its own block's text, without the fences or the info string", async () => {
    const writeText = clipboard();
    const first = "  npm ci \\\n    --ignore-scripts\n\n`tick` <b>  ";
    const second = "~~~\nnested\n~~~";
    render(
      <Markdown
        text={["```sh title=x", first, "```", "", "Between.", "", "````", second, "````"].join(
          "\n",
        )}
      />,
    );
    const [one, two] = copyButtons();
    fireEvent.click(two as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith(second);
    fireEvent.click(one as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith(first);
  });

  it("confirms a copy briefly with a check, then reverts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    clipboard();
    render(<Markdown text={"```\nmake check\n```"} />);
    const [button] = copyButtons();
    const icon = () => button?.querySelector("path")?.getAttribute("d");
    const idle = icon();
    expect(confirmation(button as HTMLElement)).toBe("");
    fireEvent.click(button as HTMLElement);
    await waitFor(() => expect(confirmation(button as HTMLElement)).not.toBe(""));
    expect(icon()).not.toBe(idle);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(confirmation(button as HTMLElement)).toBe("");
    expect(icon()).toBe(idle);
  });

  it("says so under the block where the clipboard refuses", async () => {
    clipboard(true);
    render(<Markdown text={"```\nmake check\n```"} />);
    const [button] = copyButtons();
    fireEvent.click(button as HTMLElement);
    const status = await screen.findByRole("status");
    expect(status.previousElementSibling?.querySelector("pre code")?.textContent).toBe(
      "make check",
    );
    expect(confirmation(button as HTMLElement)).toBe("");
  });

  it("copies a diagram's source where the source shows instead", async () => {
    const writeText = clipboard();
    const source = `flowchart LR\n  A --> B\n%%${"x".repeat(maxDiagramSource)}`;
    render(<Markdown text={["```mermaid", source, "```"].join("\n")} />);
    const [button] = copyButtons();
    fireEvent.click(button as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  });
});
