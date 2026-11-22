import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeApi, renderAt } from "../test-support.tsx";
import {
  firstSection,
  sectionHref,
  settingsNavigation,
  settingsSections,
} from "./settings/sections.ts";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
  api.on("GET", "/passkeys", { body: { passkeys: [], recent: true } });
  api.on("GET", "/keys", { body: { keys: [], recent: true } });
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const navigation = () => screen.getByRole("navigation", { name: "Settings" });
const settingsTab = () =>
  within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", {
    name: "Settings",
  });
const currentOf = (links: HTMLElement[]) =>
  links.map((link) => [link.getAttribute("href"), link.getAttribute("aria-current")]);

async function open(path: string, title: string) {
  renderAt(path);
  return screen.findByRole("heading", { level: 2, name: title });
}

describe("Settings' sections", () => {
  it("have addresses of their own", () => {
    const slugs = settingsSections.map((section) => section.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("are listed by group, in the groups' order, then the ones apart", async () => {
    await open("/settings", firstSection.title);
    const groups = settingsNavigation.groups.map(({ group, sections }) => [
      group,
      sections.map(sectionHref),
    ]);
    expect(
      groups.map(([group]) => [
        group,
        Array.from(
          within(navigation())
            .getByRole("list", { name: String(group) })
            .querySelectorAll("a"),
          (link) => link.getAttribute("href"),
        ),
      ]),
    ).toEqual(groups);
    expect(
      within(navigation())
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      ...settingsNavigation.groups.flatMap(({ sections }) => sections.map(sectionHref)),
      ...settingsNavigation.apart.map(sectionHref),
    ]);
  });

  it.each(settingsSections.map((section) => [section.slug, section] as const))(
    "open %s at its own address, marked as the page, within the Settings tab",
    async (_, section) => {
      const heading = await open(sectionHref(section), section.title);
      expect(currentOf(within(navigation()).getAllByRole("link"))).toEqual(
        settingsSections.map((each) => [sectionHref(each), each === section ? "page" : null]),
      );
      expect(settingsTab().getAttribute("aria-current")).toBe("true");
      expect(screen.getByRole("link", { name: "Back to settings" }).getAttribute("href")).toBe(
        "/settings",
      );
      expect(heading.closest("section")).toBe(screen.getByRole("region", { name: section.title }));
      await waitFor(() => expect(document.title).toBe(`${section.title} · Settings · Agention`));
    },
  );

  it("open the first at /settings, marked as the current one, under the Settings tab", async () => {
    await open("/settings", firstSection.title);
    expect(currentOf(within(navigation()).getAllByRole("link"))).toEqual(
      settingsSections.map((each) => [sectionHref(each), each === firstSection ? "true" : null]),
    );
    expect(settingsTab().getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(document.title).toBe("Settings · Agention"));
  });

  it("go from one to another, and back to the list", async () => {
    await open("/settings", firstSection.title);
    fireEvent.click(within(navigation()).getByRole("link", { name: "Voice" }));
    await screen.findByRole("heading", { level: 2, name: "Voice" });
    expect(window.location.pathname).toBe("/settings/voice");
    fireEvent.click(screen.getByRole("link", { name: "Back to settings" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
  });

  it("each load only what they show", async () => {
    const loads = () =>
      ["/passkeys", "/keys", "/settings"].map((path) => api.callsTo("GET", path).length);
    await open("/settings/sign-out", "Sign out");
    expect(loads()).toEqual([0, 0, 0]);
    cleanup();
    await open("/settings/passkeys", "Passkeys");
    await screen.findByRole("region", { name: "Add a passkey on this device" });
    expect(loads()).toEqual([1, 0, 0]);
    cleanup();
    await open("/settings/api-keys", "API keys");
    await screen.findByRole("button", { name: "Create an API key" });
    expect(loads()).toEqual([1, 1, 0]);
    cleanup();
    await open("/settings/voice", "Voice");
    await screen.findByRole("button", { name: "Set up" });
    expect(api.callsTo("GET", "/settings")).toHaveLength(1);
    cleanup();
    await open("/settings/storage", "Storage");
    await screen.findByText("No files are attached yet.");
    expect(api.callsTo("GET", "/settings")).toHaveLength(2);
  });

  it("are not found at a slug no section has, as at any other unknown page", async () => {
    renderAt("/settings/elsewhere");
    await screen.findByRole("heading", { level: 1, name: "Not found" });
    expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
    expect(settingsTab().hasAttribute("aria-current")).toBe(false);
  });

  it("hold the passkeys that had a page of their own, which leads there in its place", async () => {
    const entries = window.history.length;
    renderAt("/passkeys");
    await screen.findByRole("heading", { level: 2, name: "Passkeys" });
    expect(window.location.pathname).toBe("/settings/passkeys");
    expect(window.history.length).toBe(entries);
  });
});
