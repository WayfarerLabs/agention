import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FakeApi, noSettings, renderAt } from "../../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
  api.on("GET", "/passkeys", { body: { passkeys: [], recent: true } });
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

async function storage(count: number, bytes: number) {
  api.on("GET", "/settings", { body: { ...noSettings, storage: { count, bytes } } });
  renderAt("/settings");
  const section = await screen.findByRole("region", { name: "Storage" });
  // The line that replaces Loading once the settings arrive.
  return waitFor(() => {
    const line = section.querySelector("p:not(.muted)");
    expect(line).not.toBeNull();
    return line as HTMLElement;
  });
}

it("says how much space attached files take, after Voice, offering nothing to change", async () => {
  const line = await storage(340, 1.2 * 1024 ** 3);
  expect(line.textContent).toContain("1.2 GiB");
  expect(line.textContent).toContain("340 files");
  const sections = screen
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-labelledby"));
  const names = sections.map((id) => document.getElementById(id ?? "")?.textContent);
  expect(names.indexOf("Storage")).toBe(names.indexOf("Voice") + 1);
  const section = screen.getByRole("region", { name: "Storage" });
  expect(within(section).queryAllByRole("button")).toEqual([]);
  expect(within(section).queryAllByRole("textbox")).toEqual([]);
});
