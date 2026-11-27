import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { submitRegistration } from "./registrations.ts";
import { Fixture, hour, newPublicKey } from "./test-fixture.ts";

// Two keys share a code with probability 2^-50, so this file makes every key's
// code the same to show what happens when they do.
vi.mock("@wayfarerlabs/agention-server-api/registration-code", () => ({
  registrationCode: () => "AAAAA-AAAAA",
}));

let fixture: Fixture;

beforeEach(() => {
  fixture = new Fixture();
});

afterEach(() => {
  fixture.close();
});

it("refuses a key whose code matches another pending registration until that one expires", () => {
  const submit = () =>
    submitRegistration(fixture.store, newPublicKey(), { agent: "a", session: "s" });
  submit();
  expect(submit).toThrow(expect.objectContaining({ code: "invalid_input" }));
  fixture.advance(hour);
  expect(submit().status).toBe("pending");
});
