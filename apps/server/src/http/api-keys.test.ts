import {
  type ApiKeyList,
  type ApiKeyRevoked,
  apiKeySecret,
  type ApiKeySummary,
  formatTimestamp,
  maxApiKeys,
} from "@wayfarerlabs/agention-api";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hour } from "../store/test-fixture.ts";
import { codeOf, Harness } from "./test-harness.ts";

const day = 24 * hour;

let harness: Harness;

beforeEach(() => {
  harness = new Harness();
});

afterEach(() => {
  harness.close();
});

const list = async () => (await harness.web("GET", "/keys")).body as ApiKeyList;
const revoke = (id: number) => harness.web("POST", `/keys/${id}/revoke`);

describe("creating a key", () => {
  it("answers its secret once, and lists it without one", async () => {
    const created = await harness.createKey(["threads:read", "sessions:write"]);
    expect(apiKeySecret.safeParse(created.secret).success).toBe(true);
    expect(created.key).toEqual({
      id: created.key.id,
      name: "status board",
      scopes: ["threads:read", "sessions:write"],
      status: "active",
      created_at: formatTimestamp(harness.fixture.now),
    } satisfies ApiKeySummary);
    const listed = await list();
    expect(listed).toEqual({ keys: [created.key], recent: true });
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });

  it("stores only the secret's hash", async () => {
    const { secret } = await harness.createKey(["threads:read"]);
    const [row] = harness.fixture.db.prepare("SELECT * FROM api_keys").all();
    expect(Object.values(row ?? {}).some((value) => String(value).includes(secret))).toBe(false);
    expect(Buffer.from(row?.hash as Uint8Array)).toEqual(
      createHash("sha256").update(secret).digest(),
    );
  });

  it.each([
    [{ kind: "days", days: 7 }, 7 * day],
    [{ kind: "days", days: 90 }, 90 * day],
    [{ kind: "date", at: formatTimestamp(Date.UTC(2027, 0, 1)) }, undefined],
  ] as const)("expires as %j chooses", async (expiry, lifetime) => {
    const { key } = await harness.createKey(["threads:read"], expiry);
    const at = lifetime === undefined ? Date.UTC(2027, 0, 1) : harness.fixture.now + lifetime;
    expect(key.expires_at).toBe(formatTimestamp(at));
  });

  it.each([
    ["a number of days not offered", { kind: "days", days: 14 }, "expiry.days"],
    ["a date in the past", { kind: "date", at: "2020-01-01T00:00:00Z" }, "expiry.at"],
    ["a date past a year", { kind: "date", at: "2028-01-01T00:00:00Z" }, "expiry.at"],
  ])("refuses %s", async (_, expiry, field) => {
    const response = await harness.web("POST", "/keys", {
      name: "status board",
      scopes: ["threads:read"],
      expiry,
    });
    expect([
      codeOf(response),
      (response.body as { error: { field?: string } }).error.field,
    ]).toEqual(["invalid_input", field]);
  });

  it.each([
    ["no scope", []],
    ["a scope twice", ["threads:read", "threads:read"]],
    ["an unknown scope", ["keys:write"]],
  ])("refuses %s", async (_, scopes) => {
    const response = await harness.web("POST", "/keys", {
      name: "status board",
      scopes,
      expiry: { kind: "none" },
    });
    expect(codeOf(response)).toBe("invalid_input");
  });

  it(`holds at most ${maxApiKeys} live keys, a revoked one making room`, async () => {
    const keys = [];
    for (let i = 0; i < maxApiKeys; i++) {
      keys.push(await harness.createKey(["threads:read"]));
    }
    const refused = await harness.web("POST", "/keys", {
      name: "one more",
      scopes: ["threads:read"],
      expiry: { kind: "none" },
    });
    expect(codeOf(refused)).toBe("invalid_input");
    expect(codeOf(await revoke(keys[0]?.key.id ?? 0))).toBe("ok");
    await harness.createKey(["threads:read"]);
  });

  it("needs a recent sign-in, as changing passkeys does, while listing does not", async () => {
    const { key } = await harness.createKey(["threads:read"]);
    harness.fixture.advance(10 * 60 * 1000);
    const created = await harness.web("POST", "/keys", {
      name: "late",
      scopes: ["threads:read"],
      expiry: { kind: "none" },
    });
    expect(codeOf(created)).toBe("not_allowed");
    expect(codeOf(await revoke(key.id))).toBe("not_allowed");
    expect(await list()).toEqual({ keys: [key], recent: false });
    harness.signIn();
    expect(codeOf(await revoke(key.id))).toBe("ok");
  });
});

describe("revoking a key", () => {
  it("marks it revoked, and the next change to the keys deletes it", async () => {
    const { key } = await harness.createKey(["threads:read"]);
    const revoked = (await revoke(key.id)).body as ApiKeyRevoked;
    expect(revoked.key).toEqual({
      ...key,
      status: "revoked",
      revoked_at: formatTimestamp(harness.fixture.now),
    });
    expect((await list()).keys).toEqual([revoked.key]);
    const other = await harness.createKey(["threads:read"]);
    expect((await list()).keys).toEqual([other.key]);
    expect(codeOf(await revoke(key.id))).toBe("not_found");
  });

  it("is not_found for a key that does not exist", async () => {
    expect(codeOf(await revoke(1))).toBe("not_found");
  });
});

describe("expired keys", () => {
  it("are listed as expired until the next change to the keys deletes them", async () => {
    const { key } = await harness.createKey(["threads:read"], { kind: "days", days: 7 });
    harness.fixture.advance(7 * day);
    harness.signIn();
    expect((await list()).keys).toEqual([{ ...key, status: "expired" }]);
    const other = await harness.createKey(["threads:read"]);
    expect((await list()).keys).toEqual([other.key]);
  });
});

describe("key management", () => {
  it("is only on the web mount, which no key can call", async () => {
    const { secret } = await harness.createKey(["threads:write", "sessions:write"]);
    for (const [method, path] of [
      ["GET", "/keys"],
      ["POST", "/keys"],
      ["POST", "/keys/1/revoke"],
    ] as const) {
      expect([path, codeOf(await harness.operator(secret, method, path))]).toEqual([
        path,
        "not_found",
      ]);
      const asBearer = await harness.web(method, path, undefined, {
        cookie: null,
        headers: { authorization: `Bearer ${secret}` },
      });
      expect([path, codeOf(asBearer)]).toEqual([path, "unauthenticated"]);
    }
  });
});
