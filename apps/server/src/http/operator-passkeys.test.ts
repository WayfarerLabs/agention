import type { PasskeyList, PasskeyRemoved } from "@wayfarerlabs/agention-server-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recentSignIn } from "../auth/browser-sessions.ts";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { maxPasskeys } from "../auth/passkeys.ts";
import { codeOf, TestAuthenticator, TestBrowser, TestServer } from "./test-browser.ts";
import { sessionCookie } from "./test-harness.ts";

let server: TestServer;
// The operator's first passkey, and the browser it signed in.
let laptop: TestAuthenticator;
let first: TestBrowser;

const browser = () => new TestBrowser(server);

beforeEach(async () => {
  server = new TestServer();
  laptop = new TestAuthenticator();
  first = browser();
  expect(codeOf(await first.link(issuePasskeyLink(server.store, "operator"), laptop))).toBe("ok");
});

afterEach(() => {
  server.close();
});

const listed = async (b: TestBrowser) => (await b.send("GET", "/passkeys")).body as PasskeyList;
const names = async (b: TestBrowser) => (await listed(b)).passkeys.map((passkey) => passkey.name);
const idOf = async (b: TestBrowser, name: string) =>
  (await listed(b)).passkeys.find((passkey) => passkey.name === name)?.id ?? 0;
const signedIn = async (b: TestBrowser) => codeOf(await b.send("GET", "/passkeys")) === "ok";

// addAndSignIn adds a passkey from a signed-in browser and signs a new
// browser in with it.
async function addAndSignIn(from: TestBrowser, authenticator: TestAuthenticator, name: string) {
  expect(codeOf(await from.addPasskey(authenticator, name))).toBe("ok");
  const other = browser();
  expect(codeOf(await other.signIn(authenticator))).toBe("ok");
  return other;
}

describe("the passkeys list", () => {
  it("names each passkey, and which one signed this browser in", async () => {
    expect(await listed(first)).toEqual({
      passkeys: [
        {
          id: expect.any(Number),
          name: "Laptop",
          created_at: new Date(server.now).toISOString(),
          last_used_at: new Date(server.now).toISOString(),
          current: true,
        },
      ],
      recent: true,
    });
  });

  it("stamps a passkey's last use when it signs in", async () => {
    const phone = new TestAuthenticator();
    expect(codeOf(await first.addPasskey(phone, "Phone"))).toBe("ok");
    expect((await listed(first)).passkeys[1]).not.toHaveProperty("last_used_at");
    server.now += 1000;
    expect(codeOf(await browser().signIn(phone))).toBe("ok");
    expect((await listed(first)).passkeys[1]?.last_used_at).toBe(
      new Date(server.now).toISOString(),
    );
  });

  it("renames a passkey at any time, refusing a blank name", async () => {
    server.now += recentSignIn;
    const id = await idOf(first, "Laptop");
    expect(codeOf(await first.post(`/passkeys/${id}/name`, { name: "Work laptop" }))).toBe("ok");
    expect(await names(first)).toEqual(["Work laptop"]);
    const blank = await first.post(`/passkeys/${id}/name`, { name: "  " });
    expect([codeOf(blank), (blank.body as { error: { field: string } }).error.field]).toEqual([
      "invalid_input",
      "name",
    ]);
    expect(codeOf(await first.post(`/passkeys/${id + 1}/name`, { name: "Other" }))).toBe(
      "not_found",
    );
  });
});

describe("adding a passkey on this device", () => {
  it("registers it under the operator's user handle, named, beside the others", async () => {
    const options = await first.begin("/passkeys/register/begin", { name: "Phone" });
    expect(options).toMatchObject({
      user: { id: laptop.userHandle },
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: [{ id: laptop.credentialId }],
    });
    const phone = new TestAuthenticator();
    const added = await first.post("/passkeys/register/finish", {
      credential: phone.create(options, server.origin),
    });
    expect(codeOf(added)).toBe("ok");
    expect((await listed(first)).passkeys).toMatchObject([
      { name: "Laptop", current: true },
      { name: "Phone", current: false },
    ]);
    expect(codeOf(await browser().signIn(phone))).toBe("ok");
    expect(codeOf(await browser().signIn(laptop))).toBe("ok");
  });

  it("refuses a passkey already registered", async () => {
    const again = await first.addPasskey(laptop, "Laptop again");
    expect(codeOf(again)).toBe("invalid_input");
    expect(server.count("passkeys")).toBe(1);
  });
});

describe("another device", () => {
  it("signs in with a passkey the operator holds, then adds its own beside the others", async () => {
    const desk = browser();
    expect(codeOf(await desk.signIn(laptop))).toBe("ok");
    const own = new TestAuthenticator();
    expect(codeOf(await desk.addPasskey(own, "Desk"))).toBe("ok");
    expect(own.userHandle).toBe(laptop.userHandle);
    expect(await names(desk)).toEqual(["Laptop", "Desk"]);
    // It replaces nothing.
    expect(await signedIn(first)).toBe(true);
    expect(codeOf(await browser().signIn(own))).toBe("ok");
  });
});

describe("the most passkeys Agention keeps", () => {
  it("refuses one more", async () => {
    for (let n = 2; n <= maxPasskeys; n++) {
      expect(codeOf(await first.addPasskey(new TestAuthenticator(), `Key ${n}`))).toBe("ok");
    }
    expect(codeOf(await first.post("/passkeys/register/begin", { name: "One more" }))).toBe(
      "invalid_input",
    );
    expect(server.count("passkeys")).toBe(maxPasskeys);
  });

  it("is kept to by ceremonies finishing side by side", async () => {
    for (let n = 2; n < maxPasskeys; n++) {
      expect(codeOf(await first.addPasskey(new TestAuthenticator(), `Key ${n}`))).toBe("ok");
    }
    // Three ceremonies begin while one more passkey fits.
    const second = browser();
    const third = browser();
    for (const each of [second, third]) {
      expect(codeOf(await each.signIn(laptop))).toBe("ok");
    }
    const begun = [];
    for (const [each, name] of [
      [first, "First"],
      [second, "Second"],
      [third, "Third"],
    ] as const) {
      begun.push({ each, options: await each.begin("/passkeys/register/begin", { name }) });
    }
    const finished = [];
    for (const { each, options } of begun) {
      finished.push(
        codeOf(
          await each.post("/passkeys/register/finish", {
            credential: new TestAuthenticator().create(options, server.origin),
          }),
        ),
      );
    }
    expect(finished).toEqual(["ok", "invalid_input", "invalid_input"]);
    expect(server.count("passkeys")).toBe(maxPasskeys);
  });
});

describe("a passkey link", () => {
  it("replaces every passkey and ends every session", async () => {
    const other = await addAndSignIn(first, new TestAuthenticator(), "Phone");
    const desk = browser();
    expect(codeOf(await desk.link(issuePasskeyLink(server.store, "operator"), laptop))).toBe("ok");
    expect(await names(desk)).toEqual(["Laptop"]);
    expect(await signedIn(first)).toBe(false);
    expect(await signedIn(other)).toBe(false);
  });
});

describe("a recent sign-in", () => {
  it("is needed to add a passkey or remove one, until the operator signs in again", async () => {
    await addAndSignIn(first, new TestAuthenticator(), "Phone");
    server.now += recentSignIn;
    expect((await listed(first)).recent).toBe(false);
    const phone = await idOf(first, "Phone");
    const refused = [
      await first.post("/passkeys/register/begin", { name: "Tablet" }),
      await first.post(`/passkeys/${phone}/remove`),
    ];
    expect(refused.map(codeOf)).toEqual(["not_allowed", "not_allowed"]);
    expect(server.count("passkeys")).toBe(2);

    expect(codeOf(await first.signIn(laptop))).toBe("ok");
    expect((await listed(first)).recent).toBe(true);
    expect(codeOf(await first.post(`/passkeys/${phone}/remove`))).toBe("ok");
  });

  it("is needed when a passkey added on this device is finished, not only begun", async () => {
    server.now += recentSignIn - 1000;
    const options = await first.begin("/passkeys/register/begin", { name: "Tablet" });
    server.now += 1000;
    const finished = await first.post("/passkeys/register/finish", {
      credential: new TestAuthenticator().create(options, server.origin),
    });
    expect(codeOf(finished)).toBe("not_allowed");
    expect(server.count("passkeys")).toBe(1);
  });
});

describe("removing a passkey", () => {
  it("keeps the last one", async () => {
    const removed = await first.post(`/passkeys/${await idOf(first, "Laptop")}/remove`);
    expect(codeOf(removed)).toBe("invalid_input");
    expect(server.count("passkeys")).toBe(1);
  });

  it("ends exactly the browser sessions it signed in", async () => {
    const phone = new TestAuthenticator();
    const other = await addAndSignIn(first, phone, "Phone");
    const alsoPhone = browser();
    expect(codeOf(await alsoPhone.signIn(phone))).toBe("ok");
    const alsoLaptop = browser();
    expect(codeOf(await alsoLaptop.signIn(laptop))).toBe("ok");

    const removed = await first.post(`/passkeys/${await idOf(first, "Phone")}/remove`);
    expect(removed.body as PasskeyRemoved).toEqual({ signed_out: false });
    expect(await Promise.all([other, alsoPhone].map(signedIn))).toEqual([false, false]);
    expect(await Promise.all([first, alsoLaptop].map(signedIn))).toEqual([true, true]);
    expect(codeOf(await browser().signIn(phone))).toBe("unauthenticated");
  });

  it("signs this browser out when it is the passkey that signed it in", async () => {
    expect(codeOf(await first.addPasskey(new TestAuthenticator(), "Phone"))).toBe("ok");
    const removed = await first.post(`/passkeys/${await idOf(first, "Laptop")}/remove`);
    expect(removed.body as PasskeyRemoved).toEqual({ signed_out: true });
    expect(removed.setCookies).toContainEqual(expect.stringMatching(`^${sessionCookie}=;`));
    expect(await signedIn(first)).toBe(false);
    expect(server.count("passkeys")).toBe(1);
  });
});
