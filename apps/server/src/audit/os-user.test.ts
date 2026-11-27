import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { Fixture } from "../store/test-fixture.ts";
import { eventsAfter, parsed, problemsOf } from "./test-events.ts";

// A user with no entry in the system's user database, as a container started
// with a bare uid runs as, makes os.userInfo throw.
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  userInfo: () => {
    throw Object.assign(new Error("no such user"), { code: "ENOENT" });
  },
}));

let fixture: Fixture;

beforeEach(() => {
  fixture = new Fixture();
});

afterEach(() => {
  fixture.close();
});

it("names a command line user missing from the user database by uid alone", () => {
  issuePasskeyLink(fixture.store, "operator");
  const [event] = eventsAfter(fixture.db);
  expect(problemsOf(event?.event ?? "")).toEqual([]);
  const ocsf = parsed(event as never);
  expect((ocsf.actor as { user: unknown }).user).toEqual({
    uid: `os_user:${process.getuid?.()}`,
    type_id: 99,
    type: "OS user",
  });
  expect((ocsf.unmapped as { credential: unknown }).credential).toEqual({
    kind: "cli",
    command: "passkey-link",
  });
});
