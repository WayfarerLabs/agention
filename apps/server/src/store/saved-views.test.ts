import {
  maxSavedViews,
  savedViewCreateInput,
  savedViewNameInput,
  type ThreadsView,
  threadsQuery,
  threadsView,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import {
  createGroup,
  removeGroup,
  removeTag,
  renameGroup,
  renameTag,
  setSessionGroup,
  setSessionTags,
} from "./groups-and-tags.ts";
import {
  createSavedView,
  listSavedViews,
  removeSavedView,
  renameSavedView,
  replaceSavedView,
} from "./saved-views.ts";
import { type Agent, Fixture } from "./test-fixture.ts";
import { listThreads } from "./thread-lists.ts";

let fixture: Fixture;
let builder: Agent;

beforeEach(() => {
  fixture = new Fixture();
  builder = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

function failure(fn: () => unknown): { code: string; field: string | undefined } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return { code: error.code, field: error.field };
    }
    throw error;
  }
  throw new Error("expected the operation to fail");
}

const store = () => fixture.store;
const operator = () => fixture.operator;
const save = (name: string, view: Record<string, unknown> = {}) =>
  createSavedView(store(), operator(), savedViewCreateInput.parse({ name, view }));
const rename = (id: number, name: string) =>
  renameSavedView(store(), operator(), id, savedViewNameInput.parse({ name }));
const listed = () => listSavedViews(store(), operator()).views;
// The list a view opens, as listing threads reads it.
const opened = (view: ThreadsView) => listThreads(store(), operator(), threadsQuery.parse(view));
const stored = (id: number) =>
  JSON.parse(
    (fixture.db.prepare("SELECT view FROM saved_views WHERE id = ?").get(id) as { view: string })
      .view,
  ) as unknown;

describe("saved views", () => {
  it("are saved, renamed, replaced and removed, each keeping its id", () => {
    const blocking = save("Blocking me", { impact: "blocking", sort: "due" });
    expect(blocking).toEqual({
      id: blocking.id,
      name: "Blocking me",
      view: threadsView.parse({ impact: "blocking", sort: "due" }),
    });
    expect(rename(blocking.id, "Blocked")).toEqual({ ...blocking, name: "Blocked" });
    const replaced = replaceSavedView(store(), operator(), blocking.id, {
      view: threadsView.parse({ unread: true, group: "session" }),
    });
    expect(replaced).toEqual({
      id: blocking.id,
      name: "Blocked",
      view: threadsView.parse({ unread: true, group: "session" }),
    });
    expect(listed()).toEqual([replaced]);
    removeSavedView(store(), operator(), blocking.id);
    expect(listed()).toEqual([]);
  });

  it("keep every part of the list, those at their default included", () => {
    const view = save("Overdue", { overdue: true, agent: ["builder"] });
    expect(stored(view.id)).toEqual({
      overdue: true,
      unread: false,
      agent: ["builder"],
      include_archived: false,
      sort: "priority",
      reverse: false,
    });
  });

  it("are listed by name, ignoring the case of ASCII letters", () => {
    save("overdue");
    save("Blocking me");
    save("billing, by session");
    expect(listed().map((each) => each.name)).toEqual([
      "billing, by session",
      "Blocking me",
      "overdue",
    ]);
  });

  it("are named uniquely, ignoring the case of A to Z alone, and trimmed", () => {
    const work = save("  Work  ");
    expect(work.name).toBe("Work");
    expect(failure(() => save("WORK"))).toEqual({ code: "conflict", field: "name" });
    // Other letters are compared exactly.
    save("Ångström");
    save("ångström");
    const play = save("Play");
    expect(failure(() => rename(play.id, "work"))).toEqual({ code: "conflict", field: "name" });
    // A view may take its own name in another case.
    expect(rename(work.id, "WORK").name).toBe("WORK");
  });

  it("refuse an unknown id as not found", () => {
    // Even under a name another view holds.
    save("Taken");
    for (const fn of [
      () => rename(7, "Seven"),
      () => rename(7, "Taken"),
      () => replaceSavedView(store(), operator(), 7, { view: threadsView.parse({}) }),
      () => removeSavedView(store(), operator(), 7),
    ]) {
      expect(failure(fn)).toEqual({ code: "not_found", field: "id" });
    }
  });

  it("never give a removed view's id to a view saved after it", () => {
    const first = save("First");
    removeSavedView(store(), operator(), first.id);
    expect(save("Second").id).toBeGreaterThan(first.id);
  });

  it(`number at most ${maxSavedViews}`, () => {
    for (let index = 0; index < maxSavedViews; index++) {
      save(`View ${index}`);
    }
    expect(failure(() => save("One more")).code).toBe("invalid_input");
    expect(listed()).toHaveLength(maxSavedViews);
  });

  it("fail loudly on a stored list the list's view refuses, guessing nothing", () => {
    const view = save("Due", { sort: "due" });
    for (const text of ['{"sort": "soonest"}', '{"sort": "due", "shade": "red"}']) {
      fixture.db.prepare("UPDATE saved_views SET view = ? WHERE id = ?").run(text, view.id);
      expect(() => listed()).toThrow();
      expect(() => listed()).not.toThrow(ApiError);
    }
  });
});

describe("what a saved view names", () => {
  it("follows a tag's rename, keeping each name once", () => {
    setSessionTags(store(), operator(), builder.target, { tags: ["gone", "billing"] });
    removeTag(store(), operator(), "gone");
    const view = save("Billing", { tag: ["gone", "billing"] });
    const other = save("Infra", { tag: ["infra"] });
    renameTag(store(), operator(), "billing", { name: "gone" });
    expect(listed()).toEqual([{ ...view, view: threadsView.parse({ tag: ["gone"] }) }, other]);
  });

  it("keeps a removed tag's name, which keeps no threads", () => {
    setSessionTags(store(), operator(), builder.target, { tags: ["billing"] });
    fixture.createThread(builder);
    const view = save("Billing", { tag: ["billing"] });
    expect(opened(view.view).total).toBe(1);
    removeTag(store(), operator(), "billing");
    expect(listed()).toEqual([view]);
    expect(opened(view.view).total).toBe(0);
  });

  it("keeps a group by its id through its rename and its removal, which keeps no threads", () => {
    const work = createGroup(store(), operator(), { name: "Work" });
    setSessionGroup(store(), operator(), builder.target, { group: work.id });
    fixture.createThread(builder);
    const view = save("Work", { session_group: [work.id] });
    renameGroup(store(), operator(), work.id, { name: "Billing" });
    expect(listed()).toEqual([view]);
    expect(opened(view.view).total).toBe(1);
    removeGroup(store(), operator(), work.id);
    expect(listed()).toEqual([view]);
    expect(opened(view.view).total).toBe(0);
  });
});
