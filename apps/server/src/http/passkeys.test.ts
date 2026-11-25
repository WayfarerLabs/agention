import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issuePasskeyLink, passkeyLinkLifetime } from "../auth/passkey-links.ts";
import { challengeLifetime } from "../auth/sealed-challenges.ts";
import { defaultRates } from "./rates.ts";
import {
  codeOf,
  type Options,
  TestAuthenticator,
  TestBrowser,
  TestServer,
} from "./test-browser.ts";
import { challengeCookie, sessionCookie } from "./test-harness.ts";

let server: TestServer;

beforeEach(() => {
  server = new TestServer();
});

afterEach(() => {
  server.close();
});

const browser = () => new TestBrowser(server);
const link = (name = "operator") => issuePasskeyLink(server.store, name);

const cookieAttributes = "Path=/; HttpOnly; Secure; SameSite=Strict";

describe("the first passkey link", () => {
  it("creates the operator with the link's name and signs the browser in", async () => {
    const b = browser();
    expect((await b.send("GET", "/session")).body).toEqual({
      signed_in: false,
      operator_exists: false,
    });
    const begun = await b.post("/auth/link/begin", { token: link("morgan"), name: "Laptop" });
    const { options } = begun.body as { options: Options };
    expect(options).toMatchObject({
      rp: { id: "agention.test" },
      user: { name: "Agention · morgan", displayName: "Agention · morgan" },
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: [],
    });
    expect(begun.setCookies).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${challengeCookie}=[\\w.-]+; Max-Age=${challengeLifetime / 1000}; ${cookieAttributes}$`,
        ),
      ),
    ]);
    // Beginning stores nothing.
    expect(server.count("used_challenges")).toBe(0);

    const authenticator = new TestAuthenticator();
    const finished = await b.post("/auth/link/finish", {
      credential: authenticator.create(options, server.origin),
    });
    expect(finished.body).toEqual({
      signed_in: true,
      operator: { name: "morgan" },
      csrf_token: expect.any(String),
    });
    expect(finished.setCookies).toContainEqual(
      expect.stringMatching(
        new RegExp(`^${sessionCookie}=[\\w-]{43}; Max-Age=2592000; ${cookieAttributes}$`),
      ),
    );
    expect(b.cookies.has(challengeCookie)).toBe(false);
    expect((await b.send("GET", "/session")).body).toMatchObject({ signed_in: true });
    expect(codeOf(await b.send("GET", "/threads"))).toBe("ok");
  });

  type Created = ReturnType<TestAuthenticator["create"]>;
  it.each([
    ["authenticatorAttachment", (c: Created) => ({ ...c, authenticatorAttachment: null })],
    [
      "response.publicKey",
      (c: Created) => ({ ...c, response: { ...c.response, publicKey: null } }),
    ],
  ])("accepts a passkey whose answer carries %s as null", async (_, withNull) => {
    const b = browser();
    const options = await b.begin("/auth/link/begin", { token: link(), name: "Laptop" });
    const credential = new TestAuthenticator().create(options, server.origin);
    const finished = await b.post("/auth/link/finish", { credential: withNull(credential) });
    expect(codeOf(finished)).toBe("ok");
  });

  it("accepts a passkey whose answer leaves out clientExtensionResults", async () => {
    const b = browser();
    const options = await b.begin("/auth/link/begin", { token: link(), name: "Laptop" });
    const { clientExtensionResults: _, ...credential } = new TestAuthenticator().create(
      options,
      server.origin,
    );
    expect(codeOf(await b.post("/auth/link/finish", { credential }))).toBe("ok");
  });

  it("works once", async () => {
    const token = link();
    expect(codeOf(await browser().link(token, new TestAuthenticator()))).toBe("ok");
    expect(codeOf(await browser().post("/auth/link/begin", { token, name: "Laptop" }))).toBe(
      "unauthenticated",
    );
    expect(server.count("passkey_links")).toBe(0);
  });

  it("stops working once another is issued or it expires", async () => {
    const b = browser();
    const options = await b.begin("/auth/link/begin", { token: link(), name: "Laptop" });
    const current = link();
    const finished = await b.post("/auth/link/finish", {
      credential: new TestAuthenticator().create(options, server.origin),
    });
    expect(codeOf(finished)).toBe("unauthenticated");
    expect(server.count("people")).toBe(0);

    server.now += passkeyLinkLifetime;
    expect(
      codeOf(await browser().post("/auth/link/begin", { token: current, name: "Laptop" })),
    ).toBe("unauthenticated");
  });

  it.each([
    ["from another origin", { origin: "https://evil.test" }],
    ["without user verification", { userVerified: false }],
    ["inside another site's frame", { crossOrigin: true }],
  ])("refuses a passkey made %s", async (_, answer) => {
    const finished = await browser().link(link(), new TestAuthenticator(), answer);
    expect(codeOf(finished)).toBe("unauthenticated");
    expect(server.count("people")).toBe(0);
  });
});

describe("signing in", () => {
  let authenticator: TestAuthenticator;

  beforeEach(async () => {
    authenticator = new TestAuthenticator();
    expect(codeOf(await browser().link(link(), authenticator))).toBe("ok");
  });

  it("asks for a discoverable passkey without naming anyone", async () => {
    expect(await browser().begin("/auth/signin/begin")).toMatchObject({
      rpId: "agention.test",
      allowCredentials: [],
      userVerification: "required",
    });
  });

  it("opens a session and closes the browser's previous one", async () => {
    const b = browser();
    expect(codeOf(await b.signIn(authenticator))).toBe("ok");
    const first = b.cookies.get(sessionCookie);
    expect(codeOf(await b.signIn(authenticator))).toBe("ok");
    expect(b.cookies.get(sessionCookie)).not.toBe(first);
    const stale = browser();
    stale.cookies.set(sessionCookie, first ?? "");
    expect((await stale.send("GET", "/session")).body).toMatchObject({ signed_in: false });
  });

  it.each([
    ["from another origin", { origin: "https://evil.test" }],
    ["without user verification", { userVerified: false }],
    ["inside another site's frame", { crossOrigin: true }],
  ])("refuses an assertion made %s", async (_, answer) => {
    expect(codeOf(await browser().signIn(authenticator, answer))).toBe("unauthenticated");
  });

  it("refuses an assertion whose counter did not advance", async () => {
    expect(codeOf(await browser().signIn(authenticator))).toBe("ok");
    authenticator.counter -= 1;
    expect(codeOf(await browser().signIn(authenticator))).toBe("unauthenticated");
  });

  it("refuses an assertion for another user handle than the passkey's", async () => {
    authenticator.userHandle = "AAAA";
    expect(codeOf(await browser().signIn(authenticator))).toBe("unauthenticated");
  });

  it("accepts an assertion whose authenticatorAttachment is null", async () => {
    const b = browser();
    const options = await b.begin("/auth/signin/begin");
    const credential = authenticator.get(options, server.origin);
    const finished = await b.post("/auth/signin/finish", {
      credential: { ...credential, authenticatorAttachment: null },
    });
    expect(codeOf(finished)).toBe("ok");
  });

  it("accepts an assertion without clientExtensionResults, as 1Password sends", async () => {
    const b = browser();
    const options = await b.begin("/auth/signin/begin");
    const { clientExtensionResults: _, ...credential } = authenticator.get(options, server.origin);
    expect(codeOf(await b.post("/auth/signin/finish", { credential }))).toBe("ok");
  });

  it("refuses an assertion without a user handle", async () => {
    const b = browser();
    const options = await b.begin("/auth/signin/begin");
    const credential = authenticator.get(options, server.origin);
    const finished = await b.post("/auth/signin/finish", {
      credential: { ...credential, response: { ...credential.response, userHandle: null } },
    });
    expect(finished.status).toBe(401);
    expect(codeOf(finished)).toBe("unauthenticated");
  });

  it("refuses a passkey it does not know", async () => {
    expect(codeOf(await browser().signIn(new TestAuthenticator()))).toBe("unauthenticated");
  });

  it("accepts each challenge once, only within its lifetime, sealed by this server", async () => {
    // With a counter that stays at zero, only the used challenge stops a replay.
    authenticator.counting = false;
    const b = browser();
    const options = await b.begin("/auth/signin/begin");
    const sealed = b.cookies.get(challengeCookie) ?? "";
    const credential = authenticator.get(options, server.origin);
    expect(codeOf(await b.post("/auth/signin/finish", { credential }))).toBe("ok");
    b.cookies.set(challengeCookie, sealed);
    expect(codeOf(await b.post("/auth/signin/finish", { credential }))).toBe("unauthenticated");

    const late = browser();
    const lateOptions = await late.begin("/auth/signin/begin");
    server.now += challengeLifetime;
    const lateFinish = await late.post("/auth/signin/finish", {
      credential: authenticator.get(lateOptions, server.origin),
    });
    expect(codeOf(lateFinish)).toBe("unauthenticated");

    // A seal from another instance, or an altered one, is refused.
    const other = new TestServer();
    try {
      // On the same clock, so only its key can refuse the seal, not its expiry.
      other.now = server.now;
      const forged = new TestBrowser(other);
      const forgedOptions = await forged.begin("/auth/signin/begin");
      const moved = browser();
      moved.cookies.set(challengeCookie, forged.cookies.get(challengeCookie) ?? "");
      const finish = await moved.post("/auth/signin/finish", {
        credential: authenticator.get(forgedOptions, server.origin),
      });
      expect(codeOf(finish)).toBe("unauthenticated");
    } finally {
      other.close();
    }
    const altered = browser();
    const alteredOptions = await altered.begin("/auth/signin/begin");
    const [payload, seal] = (altered.cookies.get(challengeCookie) ?? "").split(".");
    const sealedChallenge = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as {
      expires: number;
    };
    sealedChallenge.expires += challengeLifetime;
    altered.cookies.set(
      challengeCookie,
      `${Buffer.from(JSON.stringify(sealedChallenge)).toString("base64url")}.${seal}`,
    );
    const alteredFinish = await altered.post("/auth/signin/finish", {
      credential: authenticator.get(alteredOptions, server.origin),
    });
    expect(codeOf(alteredFinish)).toBe("unauthenticated");
  });

  it("refuses a link ceremony's challenge", async () => {
    const b = browser();
    const options = await b.begin("/auth/link/begin", { token: link(), name: "Laptop" });
    const finished = await b.post("/auth/signin/finish", {
      credential: authenticator.get(options, server.origin),
    });
    expect(codeOf(finished)).toBe("unauthenticated");
  });

  it("deletes expired used challenges when the table is next written", async () => {
    expect(codeOf(await browser().signIn(authenticator))).toBe("ok");
    expect(codeOf(await browser().signIn(authenticator))).toBe("ok");
    // The link's ceremony and the two sign-ins.
    expect(server.count("used_challenges")).toBe(3);
    server.now += challengeLifetime;
    expect(codeOf(await browser().signIn(authenticator))).toBe("ok");
    expect(server.count("used_challenges")).toBe(1);
  });
});

describe("a flood of passkey ceremonies", () => {
  it("leaves a valid sign-in and a valid link succeeding", async () => {
    const authenticator = new TestAuthenticator();
    expect(codeOf(await browser().link(link(), authenticator))).toBe("ok");
    const flood = browser();
    for (let i = 0; i < 200; i++) {
      await flood.post("/auth/signin/begin");
      await flood.post("/auth/link/begin", { token: link(), name: "Laptop" });
    }
    const stray = new TestAuthenticator();
    for (let i = 0; i <= defaultRates.failedSignIn.burst; i++) {
      await browser().signIn(stray);
    }
    expect(codeOf(await browser().signIn(stray))).toBe("rate_limited");
    for (let i = 0; i <= defaultRates.failedLink.burst; i++) {
      await browser().post("/auth/link/begin", { token: "A".repeat(43), name: "Laptop" });
    }
    expect(
      codeOf(await browser().post("/auth/link/begin", { token: "A".repeat(43), name: "Laptop" })),
    ).toBe("rate_limited");

    expect(codeOf(await browser().signIn(authenticator))).toBe("ok");
    expect(codeOf(await browser().link(link(), new TestAuthenticator()))).toBe("ok");
  });
});

describe("a later passkey link", () => {
  it("replaces the operator's passkeys and signs out their browsers", async () => {
    const old = new TestAuthenticator();
    const first = browser();
    expect(codeOf(await first.link(link(), old))).toBe("ok");
    const oldHandle = old.userHandle;

    const replacement = new TestAuthenticator();
    const replaced = await browser().link(link(), replacement);
    expect(replaced.body).toMatchObject({ signed_in: true, operator: { name: "operator" } });
    expect(replacement.userHandle).toBe(oldHandle);
    expect(server.count("people")).toBe(1);
    expect(server.count("passkeys")).toBe(1);

    expect((await first.send("GET", "/session")).body).toMatchObject({ signed_in: false });
    expect(codeOf(await browser().signIn(old))).toBe("unauthenticated");
    expect(codeOf(await browser().signIn(replacement))).toBe("ok");
  });

  it("revokes every API key, which then lists as revoked", async () => {
    const first = browser();
    expect(codeOf(await first.link(link(), new TestAuthenticator()))).toBe("ok");
    const created = await first.post("/keys", {
      name: "status board",
      scopes: ["threads:read"],
      expiry: { kind: "none" },
    });
    expect(codeOf(created)).toBe("ok");
    const { secret } = created.body as { secret: string };
    const withKey = () =>
      server.app.request("/api/operator/v1/threads", {
        headers: { host: new URL(server.origin).host, authorization: `Bearer ${secret}` },
      });
    expect((await withKey()).status).toBe(200);

    const replacing = browser();
    expect(codeOf(await replacing.link(link(), new TestAuthenticator()))).toBe("ok");
    expect((await withKey()).status).toBe(401);
    expect((await replacing.send("GET", "/keys")).body).toMatchObject({
      keys: [{ name: "status board", status: "revoked" }],
    });
  });

  it("leaves a key that already expired listed as expired", async () => {
    const first = browser();
    expect(codeOf(await first.link(link(), new TestAuthenticator()))).toBe("ok");
    const created = await first.post("/keys", {
      name: "weekly",
      scopes: ["threads:read"],
      expiry: { kind: "days", days: 7 },
    });
    expect(codeOf(created)).toBe("ok");
    server.now += 8 * 24 * 60 * 60 * 1000;

    const replacing = browser();
    expect(codeOf(await replacing.link(link(), new TestAuthenticator()))).toBe("ok");
    expect((await replacing.send("GET", "/keys")).body).toMatchObject({
      keys: [{ name: "weekly", status: "expired" }],
    });
  });
});

describe("an origin with a port", () => {
  it("binds passkeys to its host", async () => {
    server.close();
    server = new TestServer("https://agention.test:8443");
    const authenticator = new TestAuthenticator();
    const b = browser();
    const options = await b.begin("/auth/link/begin", { token: link(), name: "Laptop" });
    expect(options).toMatchObject({ rp: { id: "agention.test" } });
    const finished = await b.post("/auth/link/finish", {
      credential: authenticator.create(options, server.origin),
    });
    expect(codeOf(finished)).toBe("ok");
    expect(await browser().begin("/auth/signin/begin")).toMatchObject({ rpId: "agention.test" });
    expect(codeOf(await browser().signIn(authenticator))).toBe("ok");
  });
});

describe("a server's name", () => {
  it("names the relying party of every new passkey, and its user beside the operator, from a link and on this device", async () => {
    server.close();
    server = new TestServer("https://agention.test", defaultRates, "Work");
    const named = {
      rp: { id: "agention.test", name: "Work" },
      user: { name: "Work · operator", displayName: "Work · operator" },
    };
    const b = browser();
    const linked = await b.begin("/auth/link/begin", { token: link(), name: "Laptop" });
    expect(linked).toMatchObject(named);
    const finished = await b.post("/auth/link/finish", {
      credential: new TestAuthenticator().create(linked, server.origin),
    });
    // The operator keeps their own name.
    expect(finished.body).toMatchObject({ operator: { name: "operator" } });
    expect(await b.begin("/passkeys/register/begin", { name: "Phone" })).toMatchObject(named);
  });
});

describe("signing out", () => {
  it("ends the session", async () => {
    const b = browser();
    expect(codeOf(await b.link(link(), new TestAuthenticator()))).toBe("ok");
    const out = await b.post("/auth/signout");
    expect(out.body).toEqual({ signed_in: false, operator_exists: true });
    expect(b.cookies.has(sessionCookie)).toBe(false);
    expect(server.count("browser_sessions")).toBe(0);
  });
});
