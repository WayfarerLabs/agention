import type { ErrorBody, NotificationsState, SavedViewList } from "@wayfarerlabs/agention-api";
import { createECDH, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { TestAuthenticator, TestBrowser } from "./test-browser.ts";
import { codeOf, Harness } from "./test-harness.ts";

// Notifications on the web mount, which alone reaches them, and what an API
// key holding saved-views:write does to a view's notifying through the
// operator mount.

let harness: Harness;

beforeEach(() => {
  harness = new Harness();
});

afterEach(() => {
  harness.close();
});

function subscription(endpoint = "https://fcm.googleapis.com/fcm/send/device-1") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
    label: "Chrome on Android",
  };
}

const state = async () => (await harness.web("GET", "/notifications")).body as NotificationsState;
const fieldOf = (response: { body: unknown }) => (response.body as ErrorBody).error.field;

async function savedView(name: string, view: Record<string, unknown>): Promise<number> {
  const created = await harness.web("POST", "/saved-views", { name, view });
  return (created.body as { id: number }).id;
}

describe("the web mount", () => {
  it("answers the public key, the devices, and the views that notify", async () => {
    const before = await state();
    expect(before).toEqual({
      public_key: harness.pushKey.publicKey,
      recent: true,
      devices: [],
      notifying: [expect.any(Number)],
    });
    const on = await harness.web("POST", "/notifications/devices", subscription());
    expect(codeOf(on)).toBe("ok");
    expect((await state()).devices).toEqual([
      {
        id: (on.body as { device: { id: number } }).device.id,
        label: "Chrome on Android",
        created_at: expect.any(String),
        current: true,
      },
    ]);
  });

  it("refuses a body that breaks a bound, naming the field", async () => {
    const good = subscription();
    for (const [body, field] of [
      [{ ...good, endpoint: "http://fcm.googleapis.com/x" }, "endpoint"],
      [{ ...good, keys: { ...good.keys, p256dh: "not base64url!" } }, "keys.p256dh"],
      [{ ...good, label: "two\nlines" }, "label"],
    ] as const) {
      const refused = await harness.web("POST", "/notifications/devices", body);
      expect([codeOf(refused), fieldOf(refused)]).toEqual(["invalid_input", field]);
    }
    const missing = await harness.web("POST", "/notifications/devices/refresh", good);
    expect([codeOf(missing), fieldOf(missing)]).toEqual(["not_found", "endpoint"]);
    const view = await harness.web("POST", "/notifications/views", { view: 0 });
    expect([codeOf(view), fieldOf(view)]).toEqual(["invalid_input", "view"]);
  });

  it("needs the session's CSRF token for a change", async () => {
    const refused = await harness.web("POST", "/notifications/devices", subscription(), {
      csrf: null,
    });
    expect(codeOf(refused)).toBe("unauthenticated");
  });

  it("names a refused filter's view when it cannot notify", async () => {
    const view = await savedView("Searching", { search: "deploy" });
    const refused = await harness.web("POST", "/notifications/views", { view });
    expect([codeOf(refused), fieldOf(refused)]).toEqual(["invalid_input", "view"]);
  });

  it("ends a device's notifications when a passkey link replaces its passkey", async () => {
    expect(codeOf(await harness.web("POST", "/notifications/devices", subscription()))).toBe("ok");
    const browser = new TestBrowser(harness);
    expect(
      (
        await browser.link(
          issuePasskeyLink(harness.fixture.store, "operator"),
          new TestAuthenticator(),
        )
      ).status,
    ).toBe(200);
    expect(
      harness.fixture.db.prepare("SELECT count(*) AS n FROM push_subscriptions").get(),
    ).toEqual({ n: 0 });
  });
});

describe("the operator mount", () => {
  it("has no notification route", async () => {
    const { secret } = await harness.createKey(["saved-views:write", "threads:write"]);
    for (const [method, path] of [
      ["GET", "/notifications"],
      ["POST", "/notifications/devices"],
      ["POST", "/notifications/views"],
    ] as const) {
      expect(
        codeOf(await harness.operator(secret, method, path, method === "GET" ? undefined : {})),
      ).toBe("not_found");
    }
  });

  it("lists saved views without whether they notify", async () => {
    const { secret } = await harness.createKey(["saved-views:read"]);
    const listed = (await harness.operator(secret, "GET", "/saved-views")).body as SavedViewList;
    expect(listed.views.length).toBeGreaterThan(0);
    for (const view of listed.views) {
      expect(Object.keys(view).sort()).toEqual(["id", "name", "view"]);
    }
  });

  it("with saved-views:write changes what notifies: a replace with a refused filter or a removal ends it", async () => {
    const { secret } = await harness.createKey(["saved-views:write"]);
    const id = await savedView("Releases", { tag: ["release"] });
    expect(codeOf(await harness.web("POST", "/notifications/views", { view: id }))).toBe("ok");
    const replace = (view: Record<string, unknown>) =>
      harness.operator(secret, "POST", `/saved-views/${id}/view`, { view });
    expect(codeOf(await replace({ impact: "blocking" }))).toBe("ok");
    expect((await state()).notifying).toContain(id);
    expect(
      codeOf(await harness.operator(secret, "POST", `/saved-views/${id}/name`, { name: "Ships" })),
    ).toBe("ok");
    expect((await state()).notifying).toContain(id);
    expect(codeOf(await replace({ search: "deploy" }))).toBe("ok");
    expect((await state()).notifying).not.toContain(id);

    const [starting] = (await state()).notifying;
    expect(codeOf(await harness.operator(secret, "POST", `/saved-views/${starting}/remove`))).toBe(
      "ok",
    );
    expect((await state()).notifying).toEqual([]);
  });

  it("keeps a view notifying through a tag's rename", async () => {
    const id = await savedView("Releases", { tag: ["release"] });
    await harness.web("POST", "/tags", { name: "release" });
    expect(codeOf(await harness.web("POST", "/notifications/views", { view: id }))).toBe("ok");
    expect(codeOf(await harness.web("POST", "/tags/release/name", { name: "ship" }))).toBe("ok");
    expect((await state()).notifying).toContain(id);
  });
});
