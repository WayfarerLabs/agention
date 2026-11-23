import { type PublicKey } from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-server-api/registration-code";
import { decodeProtectedHeader } from "jose";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent, BridgeHarness, session } from "./test-harness.ts";

let harness: BridgeHarness;

beforeEach(async () => {
  harness = await new BridgeHarness().start();
});

afterEach(async () => {
  await harness.close();
});

const hour = 60 * 60 * 1000;

// The key a request was signed with, from its token's header.
function signingKey(request: Request): string | undefined {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  return token === undefined ? undefined : (decodeProtectedHeader(token).kid as string);
}

describe("register", () => {
  it("submits a new key and gives the code for the operator to approve", async () => {
    const bridge = await harness.bridge();
    const answer = await bridge.ok("register");
    const key = harness.keyOnDisk();
    expect(answer).toMatchObject({ status: "pending", code: registrationCode(key) });
    expect(answer.message).toContain(registrationCode(key));
    expect(answer.message).toContain(`${harness.origin}/registrations`);
    expect(harness.registrations()).toMatchObject([{ public_key: key, status: "pending" }]);
  });

  it("reports a pending registration again without creating another", async () => {
    const bridge = await harness.bridge();
    const first = await bridge.ok("register");
    const key = harness.keyOnDisk();
    expect(await bridge.ok("register")).toMatchObject({ status: "pending", code: first.code });
    expect(harness.keyOnDisk()).toBe(key);
    expect(harness.registrations()).toHaveLength(1);
  });

  it("passes on the expiry only while the registration is pending", async () => {
    const bridge = await harness.bridge();
    const pending = await bridge.ok("register");
    expect(pending.expires_at).toEqual(expect.any(String));
    await harness.approve(harness.keyOnDisk(), { agent: "reviewer", session: "nightly" });
    // Approved, the pending registration's expiry is not the credential's.
    const approved = await bridge.ok("register");
    expect(approved).toMatchObject({ status: "approved" });
    expect(approved).not.toHaveProperty("expires_at");
  });

  it("answers with the names the operator granted, which every later call uses", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    const granted = { agent: "reviewer", session: "nightly" };
    await harness.approve(harness.keyOnDisk(), granted);
    expect(await bridge.ok("register")).toMatchObject({ status: "approved", ...granted });
    await bridge.ok("thread_create", { request_id: "r1", title: "A question" });
    const read = await harness.server.web("GET", "/s/reviewer/nightly/threads/1");
    expect(read.status).toBe(200);
  });

  it.each([
    ["rejected", (key: PublicKey) => harness.reject(key)],
    [
      "revoked",
      async (key: PublicKey) => {
        await harness.approve(key);
        await harness.revoke(key);
      },
    ],
  ])("replaces a %s key and registers the new one", async (status, refuse) => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    const refused = harness.keyOnDisk();
    await refuse(refused);
    const answer = await bridge.ok("register");
    const replacement = harness.keyOnDisk();
    expect(replacement).not.toBe(refused);
    expect(answer).toMatchObject({
      status: "pending",
      code: registrationCode(replacement),
      replaced: status,
    });
    expect(harness.registrations()).toMatchObject([
      { public_key: refused, status },
      { public_key: replacement, status: "pending" },
    ]);
  });

  it("replaces a key whose pending registration expired", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    const expired = harness.keyOnDisk();
    harness.server.fixture.advance(hour + 1);
    const answer = await bridge.ok("register");
    const replacement = harness.keyOnDisk();
    expect(replacement).not.toBe(expired);
    expect(answer).toMatchObject({
      status: "pending",
      code: registrationCode(replacement),
      replaced: "expired",
    });
    // Submitting the new key pruned the expired registration.
    expect(harness.registrations()).toMatchObject([{ public_key: replacement, status: "pending" }]);
  });

  it("registers its key again once the server pruned its expired registration", async () => {
    const bridge = await harness.bridge();
    const first = await bridge.ok("register");
    const key = harness.keyOnDisk();
    harness.server.fixture.advance(hour + 1);
    // Another session's registration writes the table, pruning the expired one.
    const other = await harness.bridge({ AGENTWORKS_SESSION: "other" });
    await other.ok("register");
    expect(harness.registrations().map((row) => row.public_key)).not.toContain(key);
    const answer = await bridge.ok("register");
    expect(answer).toMatchObject({ status: "pending", code: first.code });
    expect(answer).not.toHaveProperty("replaced");
    expect(harness.keyOnDisk()).toBe(key);
  });

  it("names the names to pass when the agent comes back, the proposed ones", async () => {
    const bridge = await harness.bridge();
    const again = `agent "${agent}" and session "${session}"`;
    expect((await bridge.ok("register")).message).toContain(again);
    await harness.approve(harness.keyOnDisk(), { agent: "reviewer", session: "nightly" });
    expect(await bridge.ok("register")).toMatchObject({
      agent: "reviewer",
      session: "nightly",
      message: expect.stringContaining(again) as unknown,
    });
  });

  it("uses the key a session already has", async () => {
    const first = await harness.bridge();
    await first.ok("register");
    const key = harness.keyOnDisk();
    await harness.approve(key);
    const restarted = await harness.bridge();
    expect(await restarted.ok("register")).toMatchObject({ status: "approved" });
    expect(harness.keyOnDisk()).toBe(key);
  });

  it("refuses to name another session once the bridge serves one", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register", { agent, session });
    expect(await bridge.error("register", { session: "other" })).toMatchObject({
      code: "invalid_input",
      field: "session",
    });
    expect(await bridge.error("register", { agent: "other", session })).toMatchObject({
      code: "invalid_input",
      field: "agent",
    });
    expect(await bridge.ok("register", {})).toMatchObject({ status: "pending" });
    expect(existsSync(path.dirname(harness.keyFile({ agent, session: "other" })))).toBe(false);
  });

  it("takes the session from register's names over the environment's", async () => {
    const bridge = await harness.bridge();
    const named = { agent: "tester", session: "adhoc" };
    const answer = await bridge.ok("register", named);
    expect(answer.code).toBe(registrationCode(harness.keyOnDisk(named)));
    expect(existsSync(harness.keyFile())).toBe(false);
    expect(await bridge.error("register", { session })).toMatchObject({ field: "session" });
  });

  it("fills a name register leaves out from the environment", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register", { session: "adhoc" });
    expect(existsSync(harness.keyFile({ agent, session: "adhoc" }))).toBe(true);
  });

  it("fixes the session from the environment when another tool is called first", async () => {
    const bridge = await harness.bridge();
    expect((await bridge.error("thread_list")).code).toBe("unauthenticated");
    expect(await bridge.error("register", { session: "adhoc" })).toMatchObject({
      field: "session",
    });
  });

  it.each([
    ["no names", { AGENTWORKS_AGENT: undefined, AGENTWORKS_SESSION: undefined }],
    ["empty names", { AGENTWORKS_AGENT: "", AGENTWORKS_SESSION: "" }],
    ["only an agent", { AGENTWORKS_SESSION: undefined }],
    ["a name the API refuses", { AGENTWORKS_AGENT: "Builder" }],
  ])("answers in plain text, creating nothing, given %s", async (_, environment) => {
    const bridge = await harness.bridge(environment);
    for (const tool of ["register", "thread_list"]) {
      const answer = await bridge.call(tool);
      expect([answer.isError, answer.json]).toEqual([true, undefined]);
    }
    expect(existsSync(path.join(harness.home, ".config"))).toBe(false);
    expect(harness.registrations()).toEqual([]);
  });
});

describe("the key file", () => {
  it("is a PKCS #8 Ed25519 key, private to the user, at a fixed path", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    const file = harness.keyFile();
    const pem = readFileSync(file, "utf8");
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(createPrivateKey(pem).asymmetricKeyType).toBe("ed25519");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    let dir = path.dirname(file);
    for (let level = 0; level < 5; level++, dir = path.dirname(dir)) {
      expect([dir, statSync(dir).mode & 0o777]).toEqual([dir, 0o700]);
    }
    expect(dir).toBe(harness.home);
  });

  it("is not created or replaced by tools other than register", async () => {
    const bridge = await harness.bridge();
    expect((await bridge.error("thread_list")).code).toBe("unauthenticated");
    expect(existsSync(harness.keyFile())).toBe(false);
    await bridge.ok("register");
    const key = harness.keyOnDisk();
    await harness.reject(key);
    expect((await bridge.error("thread_list")).code).toBe("unauthenticated");
    expect(harness.keyOnDisk()).toBe(key);
  });

  it("is not replaced by tools other than register once its registration expires", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    const key = harness.keyOnDisk();
    harness.server.fixture.advance(hour + 1);
    const error = await bridge.error("thread_list");
    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("register");
    expect(harness.keyOnDisk()).toBe(key);
  });

  it("that others can read is refused, naming it, until it is private again", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    const key = harness.keyOnDisk();
    chmodSync(harness.keyFile(), 0o640);
    for (const tool of ["register", "thread_list"]) {
      const answer = await bridge.call(tool);
      expect([answer.isError, answer.json]).toEqual([true, undefined]);
      expect(answer.text).toContain(harness.keyFile());
    }
    chmodSync(harness.keyFile(), 0o600);
    expect(await bridge.ok("register")).toMatchObject({ code: registrationCode(key) });
  });

  it("that is a link to a missing file is reported, not tried again and again", async () => {
    mkdirSync(path.dirname(harness.keyFile()), { recursive: true, mode: 0o700 });
    symlinkSync(path.join(path.dirname(harness.keyFile()), "missing.pem"), harness.keyFile());
    const bridge = await harness.bridge();
    const answer = await bridge.call("register");
    expect([answer.isError, answer.json]).toEqual([true, undefined]);
    expect(answer.text).toContain(harness.keyFile());
  });

  it("that does not hold a key is reported, not replaced", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    writeFileSync(harness.keyFile(), "not a key\n");
    const answer = await bridge.call("register");
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(harness.keyFile());
    expect(readFileSync(harness.keyFile(), "utf8")).toBe("not a key\n");
  });
});

describe("bridges sharing a session", () => {
  it("share one key when they start together", async () => {
    const [first, second] = await Promise.all([harness.bridge(), harness.bridge()]);
    const answers = await Promise.all([first.ok("register"), second.ok("register")]);
    const code = registrationCode(harness.keyOnDisk());
    expect(answers.map((answer) => answer.code)).toEqual([code, code]);
    expect(harness.registrations()).toHaveLength(1);
  });

  it("replace a refused key once when they race", async () => {
    const [first, second] = await Promise.all([harness.bridge(), harness.bridge()]);
    await first.ok("register");
    const refused = harness.keyOnDisk();
    await harness.reject(refused);
    const answers = await Promise.all([first.ok("register"), second.ok("register")]);
    const replacement = harness.keyOnDisk();
    expect(answers).toMatchObject([
      { status: "pending", code: registrationCode(replacement), replaced: "rejected" },
      { status: "pending", code: registrationCode(replacement), replaced: "rejected" },
    ]);
    expect(harness.registrations().map((row) => row.public_key)).toEqual([refused, replacement]);
  });

  it("report the key another bridge put in place while one registered", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    const refused = harness.keyOnDisk();
    await harness.reject(refused);
    // When the bridge submits its new key, another bridge's key replaces it.
    const other = generateKeyPairSync("ed25519").privateKey;
    let planted = false;
    harness.beforeRequest = (request) => {
      if (!planted && signingKey(request) !== refused) {
        planted = true;
        writeFileSync(harness.keyFile(), other.export({ type: "pkcs8", format: "pem" }));
      }
    };
    const answer = await bridge.ok("register");
    const onDisk = harness.keyOnDisk();
    expect(planted).toBe(true);
    expect(answer).toMatchObject({ status: "pending", code: registrationCode(onDisk) });
    expect(harness.registrations().map((row) => row.public_key)).toContain(onDisk);
  });

  it("each sign with the key now on disk", async () => {
    const [first, second] = await Promise.all([harness.bridge(), harness.bridge()]);
    await first.ok("register");
    await harness.approve(harness.keyOnDisk());
    await first.ok("thread_list");
    await harness.revoke(harness.keyOnDisk());
    expect(await second.ok("register")).toMatchObject({ replaced: "revoked" });
    const replacement = harness.keyOnDisk();
    await harness.approve(replacement);
    const keys: (string | undefined)[] = [];
    harness.beforeRequest = (request) => {
      keys.push(signingKey(request));
    };
    await first.ok("thread_list");
    expect(keys.at(-1)).toBe(replacement);
  });
});
