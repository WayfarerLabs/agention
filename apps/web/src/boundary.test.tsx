import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeApi, renderAt } from "./test-support.tsx";

// A view that fails to render, standing in for any failure the views do not
// foresee.
vi.mock("./views/Registrations.tsx", () => ({
  Registrations: () => {
    throw new Error("the view failed");
  },
}));

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
  // React reports the error it caught.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  expect(api.unhandled).toEqual([]);
});

it("keeps the navigation when a view fails to render, and starts afresh elsewhere", async () => {
  renderAt("/registrations");
  await screen.findByRole("heading", { name: "Something went wrong" });
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Threads" }));
  await screen.findByRole("heading", { name: "Threads" });
  expect(screen.queryByRole("heading", { name: "Something went wrong" })).toBeNull();
});
