import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusReminderAfter } from "./status-reminder.ts";
import { type Answer, BridgeHarness, type TestBridge } from "./test-harness.ts";

let harness: BridgeHarness;

beforeEach(async () => {
  harness = await new BridgeHarness().start();
});

afterEach(async () => {
  await harness.close();
});

// advance moves the clock the server and the bridges share.
function advance(milliseconds: number): void {
  harness.server.fixture.advance(milliseconds);
}

// reminded says whether an answer ends with a reminder: a text block after
// the answer's own.
function reminded(answer: Answer): boolean {
  const last = answer.content.at(-1);
  return answer.content.length > 1 && last?.type === "text";
}

// approvedBridge starts a bridge whose session the operator has approved,
// and has a tool answer in the session, which starts the status's clock.
async function approvedBridge(): Promise<TestBridge> {
  const bridge = await harness.bridge();
  await bridge.ok("register");
  await harness.approve(harness.keyOnDisk());
  expect(reminded(await bridge.call("thread_list"))).toBe(false);
  return bridge;
}

// remindsPastThreshold says whether a reminder comes once the threshold has
// passed since now, after checking that none comes at it.
async function remindsPastThreshold(bridge: TestBridge): Promise<boolean> {
  advance(statusReminderAfter);
  expect(reminded(await bridge.call("thread_list"))).toBe(false);
  advance(1);
  return reminded(await bridge.call("thread_list"));
}

describe("the status reminder", () => {
  it("comes once the status has gone unreported past the threshold, then once a period", async () => {
    const bridge = await approvedBridge();
    advance(statusReminderAfter);
    expect(reminded(await bridge.call("thread_list"))).toBe(false);
    advance(1);
    const answer = await bridge.call("thread_list");
    expect(answer.isError).toBe(false);
    expect(reminded(answer)).toBe(true);
    // The answer's own text is unchanged before it.
    expect(answer.json).toMatchObject({ threads: [] });
    expect(reminded(await bridge.call("message_wait"))).toBe(false);
    expect(await remindsPastThreshold(bridge)).toBe(true);
  });

  it("starts again from an update that reports working", async () => {
    const bridge = await approvedBridge();
    advance(statusReminderAfter + 1);
    // session_update's own answer carries none.
    expect(reminded(await bridge.call("session_update", { state: "working" }))).toBe(false);
    expect(reminded(await bridge.call("thread_list"))).toBe(false);
    expect(await remindsPastThreshold(bridge)).toBe(true);
  });

  it("does not come while the session last reported idle or stopped", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("session_update", { state: "idle" });
    expect(await remindsPastThreshold(bridge)).toBe(false);
    await bridge.ok("session_update", { state: "stopped", outcome: "completed" });
    expect(await remindsPastThreshold(bridge)).toBe(false);
    await bridge.ok("session_update", { state: "working" });
    expect(await remindsPastThreshold(bridge)).toBe(true);
  });

  it("keeps counting through an update the server does not log, but not one with a note", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("session_update", { state: "working", title: "Retire invoices" });
    advance(statusReminderAfter - 1000);
    // The same status again, with no note, changes nothing.
    await bridge.ok("session_update", { state: "working" });
    advance(1001);
    expect(reminded(await bridge.call("thread_list"))).toBe(true);
    advance(statusReminderAfter - 1000);
    await bridge.ok("session_update", { note: "Backfill under way." });
    advance(1001);
    expect(reminded(await bridge.call("thread_list"))).toBe(false);
  });

  it("records overlapping updates in the order the server commits them", async () => {
    const bridge = await approvedBridge();
    // The server answers the first update at once, and its answer is held
    // until released.
    const committed: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstAnswered = (): void => {};
    const answered = new Promise<void>((resolve) => (firstAnswered = resolve));
    harness.afterAnswer = async (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/status")) {
        committed.push(new URL(request.url).pathname);
        if (committed.length === 1) {
          firstAnswered();
          await held;
        }
      }
    };
    const idle = bridge.call("session_update", { state: "idle" });
    await answered;
    const working = bridge.call("session_update", { state: "working" });
    // The second update waits for the first's answer before it is sent.
    await delay(100);
    expect(committed).toHaveLength(1);
    release();
    expect((await idle).isError).toBe(false);
    expect((await working).isError).toBe(false);
    expect(committed).toHaveLength(2);
    const sessions = await harness.server.web("GET", "/sessions");
    expect(sessions.body).toMatchObject({
      agents: [{ sessions: [{ status: { state: "working" } }] }],
    });
    // The reminder follows the server's last state, working.
    expect(await remindsPastThreshold(bridge)).toBe(true);
  });

  it("is never on an error, which neither gives nor records one", async () => {
    const bridge = await approvedBridge();
    advance(statusReminderAfter + 1);
    const missing = await bridge.call("thread_get", { thread: 9 });
    expect(missing.isError).toBe(true);
    expect(missing.content).toHaveLength(1);
    // A refused update reports nothing, so the reminder is still due.
    const refused = await bridge.call("session_update", { state: "stopped" });
    expect(refused.isError).toBe(true);
    expect(reminded(await bridge.call("thread_list"))).toBe(true);
  });

  it("is never on register, and counts from the first answer in the session", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    advance(statusReminderAfter + 1);
    expect((await bridge.call("thread_list")).isError).toBe(true);
    await harness.approve(harness.keyOnDisk());
    expect(reminded(await bridge.call("register"))).toBe(false);
    expect(reminded(await bridge.call("thread_list"))).toBe(false);
    advance(statusReminderAfter + 1);
    expect(reminded(await bridge.call("register"))).toBe(false);
    expect(reminded(await bridge.call("thread_list"))).toBe(true);
  });

  it("follows file_get's image block", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", { request_id: "r1", title: "Files", text: "Files follow." });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const { upload } = await harness.operatorUploads(png, { name: "picture", type: "image/png" });
    const seq = await harness.operatorWrites(1, { attachments: [{ upload }] });
    advance(statusReminderAfter + 1);
    const answer = await bridge.call("file_get", { thread: 1, seq, name: "picture" });
    expect(answer.content.map((block) => block.type)).toEqual(["text", "image", "text"]);
  });
});
