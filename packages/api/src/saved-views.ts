import { z } from "zod";
import { singleLineText } from "./text.ts";
import { threadsView } from "./thread-lists.ts";

// The operator's saved views: each a name and one thread list as the list
// shows it, every filter, the order, its direction and the grouping, the
// value the web UI's address names a list by. Opening one shows that list.
// Only the operator reaches them, through the saved-views scopes; no agent
// route reads or writes them, and they grant nothing.

export const savedViewId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export type SavedViewId = z.infer<typeof savedViewId>;

// A view's name: plain text on one line, trimmed, 1 to 100 characters, and
// unique among views ignoring the case of ASCII letters, as a group's is.
export const savedViewName = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  singleLineText({ min: 1, max: 100 }),
);

// The most views an instance holds: a bound that keeps the list's answer
// bounded, not a limit real use reaches.
export const maxSavedViews = 200;

// A view as written: the list as listing threads takes it, without its page.
export const viewWritten = threadsView.describe(
  "The thread list: every filter, the order, its direction and the grouping, as listing " +
    "threads takes them, without the page. Kept whole, each part left out at its default then.",
);

// A view as read: its id, its name and its list, every part of it, those at
// their default when it was saved included.
export const savedView = z.object({
  id: savedViewId,
  name: z.string(),
  view: threadsView.describe(
    "The thread list as it was saved: every filter, the order, its direction and the " +
      "grouping, those at their default then included.",
  ),
});
export type SavedView = z.infer<typeof savedView>;

// Every view, in name order, ignoring the case of ASCII letters.
export const savedViewList = z.object({ views: z.array(savedView).max(maxSavedViews) });
export type SavedViewList = z.infer<typeof savedViewList>;

// Saving a view takes its name and its list.
export const savedViewCreateInput = z.object({ name: savedViewName, view: viewWritten });
export type SavedViewCreateInput = z.infer<typeof savedViewCreateInput>;

// Renaming a view takes its new name.
export const savedViewNameInput = z.object({ name: savedViewName });
export type SavedViewNameInput = z.infer<typeof savedViewNameInput>;

// Replacing a view's list takes the list in its place.
export const savedViewViewInput = z.object({ view: viewWritten });
export type SavedViewViewInput = z.infer<typeof savedViewViewInput>;
