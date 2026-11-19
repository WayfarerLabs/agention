import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { codeOf, TestAuthenticator, TestBrowser, TestServer } from "./test-browser.ts";

// A sign-in verifies the assertion against the passkey as it read it, and
// writes the new counter only if the passkey has not changed since. This file
// changes the passkey while the assertion is being verified, as a concurrent
// sign-in would.
const duringVerification = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }));

vi.mock("@simplewebauthn/server", async (original) => {
  const library = await original<typeof import("@simplewebauthn/server")>();
  return {
    ...library,
    verifyAuthenticationResponse: async (
      ...args: Parameters<typeof library.verifyAuthenticationResponse>
    ) => {
      const result = await library.verifyAuthenticationResponse(...args);
      duringVerification.hook?.();
      return result;
    },
  };
});

let server: TestServer;

beforeEach(() => {
  server = new TestServer();
});

afterEach(() => {
  duringVerification.hook = undefined;
  server.close();
});

it("refuses a sign-in whose passkey changed while its assertion was verified", async () => {
  const authenticator = new TestAuthenticator();
  const linked = await new TestBrowser(server).link(
    issuePasskeyLink(server.store, "operator"),
    authenticator,
  );
  expect(codeOf(linked)).toBe("ok");

  duringVerification.hook = () => {
    server.db.prepare("UPDATE passkeys SET data = json_set(data, '$.counter', 7)").run();
  };
  expect(codeOf(await new TestBrowser(server).signIn(authenticator))).toBe("unauthenticated");
  expect(server.count("browser_sessions")).toBe(1);

  duringVerification.hook = undefined;
  authenticator.counter = 7;
  expect(codeOf(await new TestBrowser(server).signIn(authenticator))).toBe("ok");
});
