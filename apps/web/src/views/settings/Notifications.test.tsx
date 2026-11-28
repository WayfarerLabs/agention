import type { NotificationsState, PushDevice } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeApi, noNotifications, renderAt } from "../../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const device = (id: number, label: string, current = false): PushDevice => ({
  id,
  label,
  created_at: "2026-11-20T10:00:00.000Z",
  ...(id === 1 ? { accepted_at: "2026-11-21T10:00:00.000Z" } : {}),
  current,
});

// serve answers the section's state, which the test can change.
function serve(state: Partial<NotificationsState>): { state: NotificationsState } {
  const held = { state: { ...noNotifications, ...state } };
  api.on("GET", "/notifications", () => ({ body: held.state }));
  return held;
}

const section = () => screen.getByRole("region", { name: "Notifications" });
const deviceRow = (label: string) => screen.getByRole("article", { name: `Device ${label}` });

describe("Settings' notifications", () => {
  it("says why turning on failed when the worker cannot be set up, and lets the operator try again", async () => {
    let registrations = 0;
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: () => Promise.resolve("granted"),
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: () => {
          registrations++;
          return Promise.reject(new DOMException("script failed to load", "TypeError"));
        },
        getRegistration: () => Promise.resolve(undefined),
        ready: new Promise(() => undefined),
      },
    });
    try {
      serve({});
      renderAt("/settings/notifications");
      const toggle = await within(
        await screen.findByRole("region", { name: "Notifications" }),
      ).findByRole<HTMLInputElement>("checkbox", { name: "Notifications on this device" });
      fireEvent.click(toggle);
      await within(section()).findByRole("alert");
      await waitFor(() => expect(toggle.disabled).toBe(false));
      fireEvent.click(toggle);
      await waitFor(() => expect(registrations).toBe(2));
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker");
      vi.unstubAllGlobals();
    }
  });

  it("is listed under Features, says when a browser cannot receive them, and points to Saved views", async () => {
    serve({});
    renderAt("/settings/notifications");
    await screen.findByText(/This browser cannot receive notifications/);
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(within(nav).getByRole("list", { name: "Features" })).getByRole("link", {
        name: "Notifications",
      }),
    ).toBeTruthy();
    expect(within(section()).getByText("No device receives notifications.")).toBeTruthy();
    expect(within(section()).getByRole("link", { name: "Saved views" }).getAttribute("href")).toBe(
      "/settings/saved-views",
    );
  });

  it("lists every device, marking this one, and removes another once asked", async () => {
    const held = serve({
      devices: [device(1, "Chrome on Android"), device(2, "Edge on Windows", true)],
    });
    api.on("POST", "/notifications/devices/1/remove", () => {
      held.state = { ...held.state, devices: [device(2, "Edge on Windows", true)] };
      return { body: {} };
    });
    renderAt("/settings/notifications");
    await screen.findByRole("article", { name: "Device Chrome on Android" });
    expect(within(deviceRow("Edge on Windows")).getByText("This device")).toBeTruthy();
    expect(within(deviceRow("Chrome on Android")).queryByText("This device")).toBeNull();
    expect(within(deviceRow("Edge on Windows")).getByText(/nothing sent yet/)).toBeTruthy();
    fireEvent.click(within(deviceRow("Chrome on Android")).getByRole("button", { name: "Remove" }));
    fireEvent.click(
      within(deviceRow("Chrome on Android")).getByRole("button", { name: "Remove this device" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Device Chrome on Android" })).toBeNull(),
    );
    expect(api.callsTo("POST", "/notifications/devices/1/remove")).toHaveLength(1);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 2, name: "Notifications" }),
    );
  });

  it("holds back removing another device until a recent sign-in, saying why", async () => {
    serve({
      recent: false,
      devices: [device(1, "Chrome on Android"), device(2, "Edge on Windows", true)],
    });
    renderAt("/settings/notifications");
    await screen.findByRole("article", { name: "Device Chrome on Android" });
    const other = within(deviceRow("Chrome on Android")).getByRole("button", {
      name: "Remove",
    }) as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    const why = document.getElementById(other.getAttribute("aria-describedby") ?? "");
    expect(why?.textContent).toMatch(/needs a sign-in within the last 10 minutes/);
    // This device's own Remove is turning it off, which needs none.
    expect(
      (
        within(deviceRow("Edge on Windows")).getByRole("button", {
          name: "Remove",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
