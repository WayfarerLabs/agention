import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { everySession } from "../store/index.ts";
import { codeOf, TestAuthenticator, TestBrowser, TestServer } from "./test-browser.ts";

// The operator's wait on the web mount, held by a browser session, ends with
// the session's refusal as soon as the session ends, however it ends.

let server: TestServer;
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

async function waiting(): Promise<void> {
  const { notifier } = server.store;
  for (let i = 0; i < 100 && notifier.waiting(everySession) === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(notifier.waiting(everySession)).toBe(1);
}

// endsWithItsSession holds a wait on holder's session, ends that session
// with end, and expects the wait to answer the session's refusal at once.
async function endsWithItsSession(holder: TestBrowser, end: () => Promise<unknown>) {
  const before = Date.now();
  const pending = holder.send("GET", "/wait?wait=25");
  await waiting();
  await end();
  expect(codeOf(await pending)).toBe("unauthenticated");
  expect(Date.now() - before).toBeLessThan(5000);
  expect(server.store.notifier.waiting(everySession)).toBe(0);
}

describe("the operator's wait on the web mount", () => {
  it("ends when its browser signs out", async () => {
    await endsWithItsSession(first, () => first.post("/auth/signout"));
  });

  it("ends when the passkey that signed its browser in is removed", async () => {
    const phone = new TestAuthenticator();
    expect(codeOf(await first.addPasskey(phone, "Phone"))).toBe("ok");
    const second = browser();
    expect(codeOf(await second.signIn(phone))).toBe("ok");
    const listed = (await first.send("GET", "/passkeys")).body as {
      passkeys: { id: number; name: string }[];
    };
    const id = listed.passkeys.find((passkey) => passkey.name === "Phone")?.id;
    await endsWithItsSession(second, () => first.post(`/passkeys/${id}/remove`));
  });

  it("ends when a link replaces the operator's passkeys", async () => {
    const link = issuePasskeyLink(server.store, "operator");
    await endsWithItsSession(first, () => browser().link(link, new TestAuthenticator()));
  });

  it("ends when its browser signs in again", async () => {
    await endsWithItsSession(first, () => first.signIn(laptop));
  });
});
