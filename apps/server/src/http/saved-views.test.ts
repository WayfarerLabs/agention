import {
  type ErrorBody,
  type SavedView,
  type SavedViewList,
  threadsView,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeOf, Harness } from "./test-harness.ts";

// The operator's saved views on the web mount and, through API keys, the
// operator mount.

let harness: Harness;

beforeEach(() => {
  harness = new Harness();
  // These start from no views: the starting view notifications add, which
  // notifications.test.ts covers, is removed.
  harness.fixture.db.prepare("DELETE FROM saved_views").run();
});

afterEach(() => {
  harness.close();
});

const fieldOf = (response: { body: unknown }) => (response.body as ErrorBody).error.field;
const listed = async () => ((await harness.web("GET", "/saved-views")).body as SavedViewList).views;

describe("saving a view", () => {
  it("refuses a list the thread list would refuse, naming the part, and saves nothing", async () => {
    for (const view of [{ sort: "soonest" }, { tag: ["billing", "billing"] }, { unread: "yes" }]) {
      const refused = await harness.web("POST", "/saved-views", { name: "Mine", view });
      expect([codeOf(refused), fieldOf(refused)?.split(".").slice(0, 2)]).toEqual([
        "invalid_input",
        ["view", Object.keys(view)[0]],
      ]);
    }
    expect(await listed()).toEqual([]);
  });

  it("refuses a name another view has, ignoring the case of ASCII letters", async () => {
    expect(codeOf(await harness.web("POST", "/saved-views", { name: "Overdue", view: {} }))).toBe(
      "ok",
    );
    const refused = await harness.web("POST", "/saved-views", { name: "OVERDUE", view: {} });
    expect([refused.status, codeOf(refused), fieldOf(refused)]).toEqual([409, "conflict", "name"]);
  });

  it("answers the list whole, as the list's query reads it", async () => {
    const saved = await harness.web("POST", "/saved-views", {
      name: "Billing, by session",
      view: { tag: "billing", group: "session", reverse: "true" },
    });
    expect(saved.body).toMatchObject({
      name: "Billing, by session",
      view: threadsView.parse({ tag: ["billing"], group: "session", reverse: true }),
    });
  });
});

describe("an API key", () => {
  it("with saved-views:write saves, renames, replaces and removes views", async () => {
    const { secret } = await harness.createKey(["saved-views:write"]);
    const created = await harness.operator(secret, "POST", "/saved-views", {
      name: "Blocking me",
      view: { impact: "blocking" },
    });
    expect(codeOf(created)).toBe("ok");
    const { id } = created.body as SavedView;
    const renamed = await harness.operator(secret, "POST", `/saved-views/${id}/name`, {
      name: "Blocked",
    });
    expect(renamed.body).toMatchObject({ id, name: "Blocked" });
    const replaced = await harness.operator(secret, "POST", `/saved-views/${id}/view`, {
      view: { unread: true },
    });
    expect(replaced.body).toEqual({
      id,
      name: "Blocked",
      view: threadsView.parse({ unread: true }),
    });
    expect((await harness.operator(secret, "GET", "/saved-views")).body).toEqual({
      views: [replaced.body],
    });
    const removed = await harness.operator(secret, "POST", `/saved-views/${id}/remove`);
    expect(codeOf(removed)).toBe("ok");
    expect(await listed()).toEqual([]);
  });

  it("with sessions:write alone renames a tag in the views naming it", async () => {
    await harness.web("POST", "/tags", { name: "billing" });
    await harness.web("POST", "/saved-views", { name: "Billing", view: { tag: ["billing"] } });
    const { secret } = await harness.createKey(["sessions:write"]);
    const renamed = await harness.operator(secret, "POST", "/tags/billing/name", {
      name: "payments",
    });
    expect(codeOf(renamed)).toBe("ok");
    expect((await listed()).map((each) => each.view.tag)).toEqual([["payments"]]);
  });
});
