import { type SavedView, threadsView } from "@wayfarerlabs/agention-api";
import { describe, expect, it } from "vitest";
import { currentViews } from "./saved-views.ts";

const saved = (view: Record<string, unknown>): SavedView => ({
  id: 1,
  name: "Release",
  view: threadsView.parse(view),
});

// current says whether a view saved with one list is current while another
// is on screen.
const current = (view: Record<string, unknown>, shown: Record<string, unknown>) =>
  currentViews([saved(view)], threadsView.parse(shown)).length === 1;

describe("the current view", () => {
  it("names a pull request or branch alike whatever case its repository is written in", () => {
    expect(
      current(
        { pull_request: ["Acme/App#1", "acme/tools#2"] },
        { pull_request: ["ACME/Tools#2", "acme/app#1"] },
      ),
    ).toBe(true);
    expect(current({ branch: ["Acme/App:main"] }, { branch: ["acme/app:main"] })).toBe(true);
  });

  it("tells apart a branch written in another case, and another number", () => {
    expect(current({ branch: ["acme/app:Main"] }, { branch: ["acme/app:main"] })).toBe(false);
    expect(current({ pull_request: ["acme/app#1"] }, { pull_request: ["acme/app#2"] })).toBe(false);
  });
});
