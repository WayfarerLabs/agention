import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { hashOfSecret } from "../auth/secrets.ts";
import { uploaded } from "../http/file-test-support.ts";
import { TestAuthenticator, TestBrowser } from "../http/test-browser.ts";
import { codeOf, Harness, newThread } from "../http/test-harness.ts";
import { testDirectory } from "../test-directory.ts";
import { AuditDispatcher, type Sink } from "./dispatcher.ts";
import { FileSink } from "./sinks/file.ts";
import { stdoutSink } from "./sinks/stdout.ts";
import { eventsAfter } from "./test-events.ts";

// Nothing secret and no content reaches the audit log: a marker planted in
// every secret and every content field the writes below carry appears in no
// event, in what the sinks deliver, in no cursor and in no line the server
// logs, and neither does any secret the server holds, in any of the encodings
// it keeps one in.

let harness: Harness;

beforeEach(() => {
  harness = new Harness();
});

afterEach(() => {
  harness.close();
});

const marker = "MARKER";
// A topic is lower case only.
const topicMarker = "marker-topic";

it("keeps every secret and all content out of the log", async () => {
  const secrets: string[] = [];
  const keep = (...values: (string | Buffer | Uint8Array | undefined)[]) => {
    for (const value of values) {
      if (value === undefined) {
        continue;
      }
      if (typeof value === "string") {
        secrets.push(value);
      } else {
        const bytes = Buffer.from(value);
        secrets.push(bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url"));
      }
    }
  };
  keep(harness.cookie, hashOfSecret(harness.cookie), harness.csrf);
  const challengeKey = harness.fixture.db.prepare("SELECT challenge_key FROM instance").get() as {
    challenge_key: Uint8Array;
  };
  keep(challengeKey.challenge_key);

  // An agent's writes, with a marker in each content field, and its token.
  const agent = await harness.approvedAgent("builder", "main");
  const file = await uploaded(harness, "agent", agent, Buffer.from(`${marker}-bytes`), {
    name: `${marker}-file.txt`,
  });
  keep(await harness.token(agent));
  const created = await harness.agent(
    agent,
    "POST",
    "/s/builder/main/threads",
    newThread("r-1", {
      title: `${marker}-title`,
      text: `${marker}-text`,
      detail: `${marker}-detail`,
      topic: topicMarker,
      references: [{ label: `${marker}-label`, url: `https://example.test/${marker}` }],
      asks: [{ question: `${marker}-question`, suggestions: [{ label: `${marker}-suggestion` }] }],
      attachments: [{ upload: file.upload, name: `${marker}-attached.txt` }],
      note: `${marker}-note`,
    }),
  );
  expect(codeOf(created)).toBe("ok");
  await harness.agent(agent, "POST", "/s/builder/main/status", {
    title: `${marker}-status-title`,
    goal: `${marker}-goal`,
    note: `${marker}-status-note`,
  });

  // The operator's, through the browser and a key.
  const answered = await harness.web("POST", "/s/builder/main/threads/1/messages", {
    request_id: "o-1",
    seen_through: 1,
    answers: [{ ask: 1, text: `${marker}-answer` }],
  });
  expect(codeOf(answered)).toBe("ok");
  const { secret } = await harness.createKey(["threads:write"]);
  keep(secret, hashOfSecret(secret));
  await harness.operator(secret, "POST", "/s/builder/main/threads", {
    request_id: "o-2",
    title: `${marker}-operator-title`,
    text: `${marker}-operator-text`,
  });
  await harness.web("POST", "/settings/voice", {
    base_url: "https://stt.test/v1",
    model: "m",
    prompt: `${marker}-prompt`,
    api_key: `sk-${marker}-transcription-key`,
  });
  // A saved view, whose list's search is text the operator typed.
  const saved = await harness.web("POST", "/saved-views", {
    name: "Searching",
    view: { search: `${marker}-search` },
  });
  expect(codeOf(saved)).toBe("ok");
  const view = (saved.body as { id: number }).id;
  const replaced = await harness.web("POST", `/saved-views/${view}/view`, {
    view: { search: `${marker}-replaced-search` },
  });
  expect(codeOf(replaced)).toBe("ok");
  // A device's notifications, whose endpoint and keys are secrets the server
  // holds, turned on, refreshed under new keys and removed, and the view's
  // notifying turned on and off, with the server's push key kept.
  keep(
    (
      harness.fixture.db.prepare("SELECT vapid_private_key FROM instance").get() as {
        vapid_private_key: Uint8Array;
      }
    ).vapid_private_key,
  );
  const subscription = () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = randomBytes(16);
    keep(ecdh.getPublicKey(), auth);
    return {
      endpoint: `https://fcm.googleapis.com/fcm/send/${marker}-endpoint`,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
      label: "Chrome on Android",
    };
  };
  const turnedOn = await harness.web("POST", "/notifications/devices", subscription());
  expect(codeOf(turnedOn)).toBe("ok");
  const device = (turnedOn.body as { device: { id: number } }).device.id;
  expect(codeOf(await harness.web("POST", "/notifications/devices/refresh", subscription()))).toBe(
    "ok",
  );
  expect(codeOf(await harness.web("POST", `/notifications/devices/${device}/remove`))).toBe("ok");
  const plain = await harness.web("POST", "/saved-views", { name: "Plain", view: {} });
  const plainId = (plain.body as { id: number }).id;
  expect(codeOf(await harness.web("POST", "/notifications/views", { view: plainId }))).toBe("ok");
  expect(codeOf(await harness.web("POST", `/notifications/views/${plainId}/remove`))).toBe("ok");
  await harness.web("POST", "/transcriptions", Buffer.from(`${marker}-audio`), {
    headers: { "content-type": "audio/webm" },
  });

  // A key's refusal, which the log records, with a marker in its path and
  // its body.
  const { secret: reader } = await harness.createKey(["threads:read"]);
  const refused = await harness.operator(reader, "POST", `/s/${marker}/main/threads/1/read`, {
    through: 1,
    x: marker,
  });
  expect(codeOf(refused)).toBe("not_found");
  expect(eventsAfter(harness.fixture.db).at(-1)?.action).toBe("authorizeScope");

  // A link, its passkey, and the sign-in after it.
  const token = issuePasskeyLink(harness.fixture.store, "operator");
  keep(token, hashOfSecret(token));
  const browser = new TestBrowser(harness);
  const authenticator = new TestAuthenticator();
  expect((await browser.link(token, authenticator)).status).toBe(200);
  expect((await browser.signIn(authenticator)).status).toBe(200);
  for (const value of browser.cookies.values()) {
    keep(value, hashOfSecret(value));
  }
  keep(browser.csrf);
  const passkeys = harness.fixture.db.prepare("SELECT credential_id, data FROM passkeys").all() as {
    credential_id: string;
    data: string;
  }[];
  for (const passkey of passkeys) {
    keep(passkey.credential_id, (JSON.parse(passkey.data) as { public_key: string }).public_key);
  }
  const recorded = eventsAfter(harness.fixture.db).map((event) => event.event);
  expect(recorded.length).toBeGreaterThan(10);

  // Delivered to a stream, to a file, and to a sink that fails, which says
  // so on stderr, once the refusal's minute has ended.
  harness.fixture.advance(60_000);
  let delivered = "";
  const stream = new Writable({
    write(chunk: Buffer, _, callback) {
      delivered += chunk.toString();
      callback();
    },
  });
  const directory = path.join(testDirectory("audit-secrets"), "audit");
  const failing: Sink = {
    kind: "file",
    deliver: async () => {
      throw Object.assign(new Error("input/output error"), { code: "EIO" });
    },
    close: async () => undefined,
  };
  const stderr: string[] = [];
  for (const sinks of [
    [
      stdoutSink(stream),
      FileSink.open({
        directory,
        gid: undefined,
        keepDays: 1,
        clock: harness.fixture.store.clock,
      }),
    ],
    [failing],
  ]) {
    const dispatcher = new AuditDispatcher(harness.fixture.store, sinks, {
      log: (line) => stderr.push(line),
      retryInterval: 5,
    });
    dispatcher.start();
    for (
      let i = 0;
      i < 200 && stderr.length === 0 && delivered.split("\n").length <= recorded.length;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await dispatcher.stop();
    await Promise.all(sinks.map((sink) => sink.close()));
  }
  expect(delivered.split("\n").filter((line) => line !== "")).toHaveLength(recorded.length);
  expect(stderr.length).toBeGreaterThan(0);
  const written = readFileSync(path.join(directory, "audit.jsonl"), "utf8");

  const sinks = JSON.stringify(harness.fixture.db.prepare("SELECT * FROM audit_sinks").all());
  for (const text of [...recorded, ...harness.logged, ...stderr, delivered, written, sinks]) {
    expect(text).not.toContain(marker);
    expect(text).not.toContain(topicMarker);
    for (const value of secrets) {
      expect(text).not.toContain(value);
    }
  }
});
