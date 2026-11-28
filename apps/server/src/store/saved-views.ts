import {
  maxSavedViews,
  refusedFiltersOn,
  type SavedView,
  type SavedViewCreateInput,
  type SavedViewList,
  type SavedViewNameInput,
  type SavedViewViewInput,
  type ThreadsView,
  threadsView,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import { ApiError, invalidInput, notFound } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { operate, type Store } from "./store.ts";

// The operator's saved views. Only the operator reaches them, through the
// saved-views scopes their identity holds: saved-views:read to list them,
// saved-views:write to change them; to anyone else they do not exist. A view
// is a name and one thread list, stored whole as the list's view parsed it,
// every part included, so a view keeps the list as it was saved, the
// defaults then in force among it. It is the operator's configuration, not a
// log, so it changes in place. A view may also notify (notifications.ts),
// which no saved views operation reads, and two of their writes change:
// replacing a view's list with one notifying refuses ends its notifying, and
// removing a view ends it with the view.

// A view's row, its list as the JSON text it was stored as.
interface ViewRow {
  id: number;
  name: string;
  view: string;
}

// A stored list read back. It is persisted state, so it is checked rather
// than trusted, and strictly: a part the list's view does not have fails as
// loudly as a value it refuses, a server error rather than a guess. A change
// to the list's view that would refuse a stored one ships with a migration
// rewriting the stored views, so this never meets one.
const storedView = threadsView.strict();

export const readView = (text: string): ThreadsView => storedView.parse(JSON.parse(text));

const savedViewOf = (row: ViewRow): SavedView => ({
  id: row.id,
  name: row.name,
  view: readView(row.view),
});

// conflict refuses a name another view already has.
function conflict(): ApiError {
  return new ApiError("conflict", "another saved view already has this name", { field: "name" });
}

// viewNamed finds the view holding a name, ignoring the case of ASCII
// letters, as the name's uniqueness does.
function viewNamed(db: Database, name: string): number | undefined {
  const row = db.prepare("SELECT id FROM saved_views WHERE name = ?").get(name) as
    { id: number } | undefined;
  return row?.id;
}

// readSavedView reads a view as its changes answer it, refusing one that
// does not exist as not found.
function readSavedView(db: Database, id: number): SavedView {
  const row = db.prepare("SELECT id, name, view FROM saved_views WHERE id = ?").get(id) as
    ViewRow | undefined;
  if (row === undefined) {
    throw notFound("id");
  }
  return savedViewOf(row);
}

// viewName reads a view's name, without its list, refusing a view that does
// not exist as not found.
function viewName(db: Database, id: number): string {
  const row = db.prepare("SELECT name FROM saved_views WHERE id = ?").get(id) as
    { name: string } | undefined;
  if (row === undefined) {
    throw notFound("id");
  }
  return row.name;
}

// listSavedViews lists every view, by name, ignoring the case of ASCII
// letters, as the column's collation orders it.
export function listSavedViews(store: Store, identity: Identity): SavedViewList {
  return operate(store, identity, "saved-views:read", (db) => {
    const rows = db
      .prepare("SELECT id, name, view FROM saved_views ORDER BY name, id")
      .all() as unknown as ViewRow[];
    return { views: rows.map(savedViewOf) };
  });
}

// createSavedView saves a list under a name no view has, while the instance
// holds fewer than maxSavedViews.
export function createSavedView(
  store: Store,
  identity: Identity,
  input: SavedViewCreateInput,
): SavedView {
  return operate(store, identity, "saved-views:write", (db, record) => {
    if (viewNamed(db, input.name) !== undefined) {
      throw conflict();
    }
    const { count } = db.prepare("SELECT count(*) AS count FROM saved_views").get() as {
      count: number;
    };
    if (count >= maxSavedViews) {
      throw invalidInput(
        undefined,
        `there are already ${maxSavedViews} saved views, the most there can be`,
      );
    }
    const { id } = db
      .prepare("INSERT INTO saved_views (name, view, created_at) VALUES (?, ?, ?) RETURNING id")
      .get(input.name, JSON.stringify(input.view), store.clock()) as { id: number };
    record("createSavedView", { view: { id, name: input.name } });
    return readSavedView(db, id);
  });
}

// renameSavedView names a view anew, keeping its list and its id.
export function renameSavedView(
  store: Store,
  identity: Identity,
  id: number,
  input: SavedViewNameInput,
): SavedView {
  return operate(store, identity, "saved-views:write", (db, record) => {
    const previousName = viewName(db, id);
    const holder = viewNamed(db, input.name);
    if (holder !== undefined && holder !== id) {
      throw conflict();
    }
    db.prepare("UPDATE saved_views SET name = ? WHERE id = ?").run(input.name, id);
    record("renameSavedView", { view: { id, name: input.name }, previousName });
    return readSavedView(db, id);
  });
}

// notifies reads whether a view notifies, refusing one that does not exist as
// not found.
function notifies(db: Database, id: number): boolean {
  const row = db.prepare("SELECT notifies FROM saved_views WHERE id = ?").get(id) as
    { notifies: number } | undefined;
  if (row === undefined) {
    throw notFound("id");
  }
  return row.notifies === 1;
}

// replaceSavedView puts another list in place of a view's, keeping its name
// and its id. A list with a filter on that a notifying view refuses ends the
// view's notifying in the same update, so no view that notifies has one on;
// any other keeps it, and the next check matches the new list. This is a
// write across resources that saved-views:write allows: an API key holding
// it changes what notifies, though it can neither see nor set which views do.
export function replaceSavedView(
  store: Store,
  identity: Identity,
  id: number,
  input: SavedViewViewInput,
): SavedView {
  return operate(store, identity, "saved-views:write", (db, record) => {
    const notified = notifies(db, id);
    const refused = refusedFiltersOn(input.view).length > 0;
    db.prepare("UPDATE saved_views SET view = ?, notifies = IIF(?, 0, notifies) WHERE id = ?").run(
      JSON.stringify(input.view),
      refused ? 1 : 0,
      id,
    );
    const saved = readSavedView(db, id);
    record("replaceSavedView", {
      view: { id, name: saved.name },
      endedNotifying: notified && refused,
    });
    return saved;
  });
}

// removeSavedView removes a view, which leaves every list and thread as it
// was, and ends its notifying with it when it notifies.
export function removeSavedView(store: Store, identity: Identity, id: number): void {
  operate(store, identity, "saved-views:write", (db, record) => {
    const removed = db
      .prepare("DELETE FROM saved_views WHERE id = ? RETURNING name, notifies")
      .get(id) as { name: string; notifies: number } | undefined;
    if (removed === undefined) {
      throw notFound("id");
    }
    record("removeSavedView", {
      view: { id, name: removed.name },
      endedNotifying: removed.notifies === 1,
    });
  });
}

// renameTagInSavedViews renames a tag in every view naming it, inside the
// caller's transaction, the tag's own renaming, so a view keeps naming the
// tag it named. A name the tag filter would then hold twice, as when a view
// names a removed tag of the new name too, is kept once, where it first
// stands, since the filter refuses a name twice. It needs no saved-views
// scope: renaming the tag renames it everywhere it is named, as it does on
// everything carrying it.
export function renameTagInSavedViews(db: Database, from: string, to: string): void {
  const rows = db
    .prepare(
      `SELECT id, name, view FROM saved_views
       WHERE EXISTS (SELECT 1 FROM json_each(view, '$.tag') WHERE value = ?)`,
    )
    .all(from) as unknown as ViewRow[];
  const write = db.prepare("UPDATE saved_views SET view = ? WHERE id = ?");
  for (const row of rows) {
    const view = readView(row.view);
    const tag = [...new Set((view.tag ?? []).map((each) => (each === from ? to : each)))];
    write.run(JSON.stringify({ ...view, tag }), row.id);
  }
}
