import { readdirSync, realpathSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { maxLinks, maxUrlLength } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maxResultBytes } from "./fit.ts";
import { agent, BridgeHarness, session, type TestBridge } from "./test-harness.ts";

// The agent compatibility suite, which CONTRIBUTING.md "The agent API"
// describes: each released bridge that scripts/check-agent-compatibility.sh
// installs, under its version in AGENTION_RELEASED_BRIDGES, against the
// server at HEAD.

const releases = process.env.AGENTION_RELEASED_BRIDGES;
if (releases === undefined || releases === "") {
  throw new Error(
    "AGENTION_RELEASED_BRIDGES must name the directory of installed bridge releases; " +
      "scripts/check-agent-compatibility.sh sets it",
  );
}
const versions = readdirSync(releases).sort();
if (versions.length === 0) {
  throw new Error(`${releases} holds no installed bridge release`);
}

// A time to answer by, well ahead, so no ask is overdue as the suite runs.
const answerBy = "2099-01-01T00:00:00Z";

const ask = {
  question: "Ship the release today?",
  suggestions: [
    { label: "Ship it", description: "Tag and publish now." },
    { label: "Wait", description: "Hold for the docs." },
  ],
  multiple: true,
  impact: "blocking",
  priority: "high",
  effort: "quick",
  answer_by: answerBy,
  fallback: "Ship tomorrow morning.",
};

describe.each(versions)("the bridge released as %s", (version) => {
  let harness: BridgeHarness;
  let bridge: TestBridge;

  beforeEach(async () => {
    harness = await new BridgeHarness().start();
    const entry = realpathSync(
      path.join(releases, version, "node_modules", ".bin", "agention-mcp"),
    );
    ({ bridge } = await harness.process({ entry }));
  });

  afterEach(async () => {
    await harness.close();
  });

  it("works through every tool it has against this server", { timeout: 60_000 }, async () => {
    expect(bridge.client.getServerVersion()?.version).toBe(version);
    const { tools } = await bridge.client.listTools();
    const has = (tool: string) => tools.some((each) => each.name === tool);
    // takes says whether a tool the release has takes a field.
    const takes = (tool: string, field: string) =>
      tools.find((each) => each.name === tool)?.inputSchema.properties?.[field] !== undefined;
    const called = new Set<string>();
    // call calls a tool that must succeed.
    const call = (tool: string, args: Record<string, unknown> = {}) => {
      called.add(tool);
      return bridge.ok(tool, args);
    };
    const numbers = async (args: Record<string, unknown>) =>
      ((await call("thread_list", args)).threads as { number: number }[])
        .map((thread) => thread.number)
        .sort();

    // Registration, before and after the operator approves.
    expect(await call("register")).toMatchObject({ status: "pending" });
    await harness.approve(harness.keyOnDisk());
    expect(await call("register")).toMatchObject({ status: "approved", agent, session });
    if (has("session_update")) {
      expect(
        await call("session_update", { state: "working", title: "The release", goal: "Ship" }),
      ).toEqual({ state: "working", title: "The release", goal: "Ship" });
    }

    // A thread whose first message carries every part, and the operator's
    // answer, which a wait reports and the thread reads back.
    expect(
      await call("thread_create", {
        request_id: "compat-1",
        title: "Release notes",
        topic: "release",
        text: "The release is ready.",
        detail: "## Changes\n\n- Session status.",
        references: [{ label: "Pull request", url: "https://example.com/pull/1" }],
        asks: [ask, { question: "Update the docs first?", suggestions: [] }],
      }),
    ).toEqual({ number: 1, seq: 1 });
    await harness.operatorWrites(1, {
      text: "Go ahead.",
      answers: [{ ask: 1, picks: [0], text: "Before noon." }],
    });
    const woken = await call("message_wait", { wait_seconds: 5 });
    expect(woken.threads).toMatchObject([{ number: 1, unread: 1 }]);
    const read = await call("thread_get", { thread: 1, after: 0, limit: 10 });
    expect(read).toMatchObject({
      thread: { number: 1, topic: "release", open_asks: { asks: [{ number: 2, seq: 1 }] } },
      messages: [
        {
          seq: 1,
          asks: [
            { number: 1, open: false },
            { number: 2, open: true },
          ],
        },
        {
          seq: 2,
          author: { kind: "person" },
          answers: [{ ask: 1, picks: [0], labels: ["Ship it"], text: "Before noon." }],
        },
      ],
    });
    expect(await call("thread_read", { thread: 1, through: 2 })).toEqual({
      cursors: { requester: 2, audience: 2 },
    });

    // A withdrawal, a replacement that withdraws again, and a stale write,
    // which lists what its writer missed.
    const withdrawal = { ask: 2, reason: "The docs can follow." };
    expect(
      await call("message_send", {
        thread: 1,
        request_id: "compat-2",
        seen_through: 2,
        text: "Shipping now.",
        withdrawals: [withdrawal],
      }),
    ).toEqual({ number: 1, seq: 3 });
    expect(
      await call("message_send", {
        thread: 1,
        request_id: "compat-3",
        seen_through: 3,
        text: "Shipping before noon.",
        withdrawals: [withdrawal],
        replaces: 3,
      }),
    ).toEqual({ number: 1, seq: 4 });
    expect(
      await bridge.error("message_send", {
        thread: 1,
        request_id: "compat-4",
        seen_through: 2,
        text: "Late.",
      }),
    ).toMatchObject({ code: "stale", missed: [{ seq: 3 }, { seq: 4 }] });

    // A later message carrying the other parts: a new ask, a new topic, its
    // detail and references, which the thread reads back.
    const later = {
      text: "One more before the tag.",
      detail: "## Left\n\n- The announcement.",
      references: [{ label: "Announcement draft", identifier: "DOC-7" }],
    };
    expect(
      await call("message_send", {
        thread: 1,
        request_id: "compat-5",
        seen_through: 4,
        ...later,
        topic: "shipping",
        asks: [
          { question: "Announce it today?", suggestions: [{ label: "Yes" }, { label: "No" }] },
        ],
      }),
    ).toEqual({ number: 1, seq: 5 });
    expect(await call("thread_get", { thread: 1, after: 4 })).toMatchObject({
      thread: { topic: "shipping", open_asks: { asks: [{ number: 3, seq: 5 }] } },
      messages: [{ seq: 5, ...later, topic: "shipping", asks: [{ number: 3, open: true }] }],
    });

    // A second thread, and the list's filters.
    expect(
      await call("thread_create", {
        request_id: "compat-6",
        title: "Docs to write",
        topic: "docs",
        references: [{ label: "Release notes", thread: 1 }],
      }),
    ).toEqual({ number: 2, seq: 1 });
    await harness.operatorWrites(2, { text: "Noted." });
    expect(await numbers({})).toEqual([1, 2]);
    expect(await numbers({ status: "open" })).toEqual([1]);
    expect(await numbers({ status: "none" })).toEqual([2]);
    expect(await numbers({ search: "docs" })).toEqual([2]);
    expect(await numbers({ topic: "shipping" })).toEqual([1]);
    expect(await numbers({ unread: true })).toEqual([2]);
    const page = await call("thread_list", { limit: 1 });
    expect(page.threads).toHaveLength(1);
    expect(await numbers({ cursor: page.next, limit: 1 })).toHaveLength(1);

    // Archiving, and a wait for nothing newer than the last one saw.
    expect(await call("thread_archive", { thread: 1, through: 5 })).toEqual({
      marks: { read_through: 5, archived_through: 5 },
    });
    expect(await numbers({})).toEqual([2]);
    expect(await numbers({ include_archived: true })).toEqual([1, 2]);
    await call("thread_read", { thread: 2, through: 2 });
    const settled = await call("message_wait", { wait_seconds: 0 });
    expect(await call("message_wait", { since: settled.since, wait_seconds: 1 })).toMatchObject({
      threads: [],
    });

    // Files. The operator's message carrying one wakes a wait, and its
    // attachments and the thread's file totals pass through to a bridge that
    // cannot fetch them.
    expect(
      await call("thread_create", {
        request_id: "compat-7",
        title: "Screenshots",
        text: "Send me the screenshot.",
      }),
    ).toEqual({ number: 3, seq: 1 });
    const screenshot = Buffer.from("not really a PNG");
    const shot = await harness.operatorUploads(screenshot, {
      name: "screen.png",
      type: "image/png",
    });
    await harness.operatorWrites(3, {
      text: "Here it is.",
      attachments: [{ upload: shot.upload }],
    });
    expect(
      (await call("message_wait", { since: settled.since, wait_seconds: 5 })).threads,
    ).toMatchObject([{ number: 3, unread: 1 }]);
    const carried = { name: "screen.png", file: shot.upload, size: screenshot.length };
    expect(await call("thread_get", { thread: 3, after: 1 })).toMatchObject({
      files: { count: 1, bytes: screenshot.length },
      messages: [{ seq: 2, attachments: [{ ...carried, type: "image/png" }] }],
    });

    // A message of the agent's own carrying a file, written through the API,
    // which the bridge then replaces without keeping it: the file stays with
    // the message it replaced, and leaves the thread's totals, which count
    // the files of live messages only.
    const { api, key } = harness.asAgent();
    const report = path.join(harness.home, "report.txt");
    writeFileSync(report, "The report.\n");
    const file = await open(report, "r");
    let upload: string;
    try {
      ({ upload } = (await api.upload(key, {
        path: `/s/${agent}/${session}/uploads`,
        query: { name: "report.txt" },
        file,
        size: (await file.stat()).size,
        type: "text/plain",
      })) as { upload: string });
    } finally {
      await file.close();
    }
    await api.request(key, {
      method: "POST",
      path: `/s/${agent}/${session}/threads/3/messages`,
      body: {
        request_id: "compat-8",
        seen_through: 2,
        text: "The report.",
        attachments: [{ upload }],
      },
    });
    expect(
      await call("message_send", {
        thread: 3,
        request_id: "compat-9",
        seen_through: 3,
        text: "The report, revised.",
        replaces: 3,
      }),
    ).toEqual({ number: 3, seq: 4 });
    const replaced = await call("thread_get", { thread: 3, after: 2 });
    expect(replaced).toMatchObject({
      files: { count: 1, bytes: screenshot.length },
      messages: [
        {
          seq: 3,
          live: false,
          replaced_by: 4,
          attachments: [{ name: "report.txt", file: upload }],
        },
        { seq: 4, live: true },
      ],
    });
    expect((replaced.messages as object[])[1]).not.toHaveProperty("attachments");

    // The file tools, in a release that has them.
    if (has("file_get")) {
      expect(await call("file_get", { thread: 3, seq: 2, name: "screen.png" })).toMatchObject({
        name: carried.name,
        size: carried.size,
      });
    }
    if (has("file_upload")) {
      const notes = path.join(harness.home, "notes.txt");
      writeFileSync(notes, "Notes.\n");
      const uploaded = await call("file_upload", { path: notes });
      expect(
        await call("message_send", {
          thread: 3,
          request_id: "compat-10",
          seen_through: 4,
          text: "My notes.",
          attachments: [{ upload: uploaded.upload }],
        }),
      ).toEqual({ number: 3, seq: 5 });
    }

    // A status reported beside a write, in a release whose writes take one.
    if (takes("thread_create", "state")) {
      expect(
        await call("thread_create", {
          request_id: "compat-11",
          title: "Waiting",
          text: "Over to you.",
          state: "idle",
          note: "Asked.",
        }),
      ).toEqual({ number: 4, seq: 1 });
      expect((await harness.server.web("GET", "/sessions")).body).toMatchObject({
        agents: [{ sessions: [{ status: { state: "idle", note: "Asked." } }] }],
      });
      if (takes("message_send", "state")) {
        expect(
          await call("message_send", {
            thread: 4,
            request_id: "compat-12",
            seen_through: 1,
            text: "Back on it.",
            state: "working",
            note: "Resumed.",
          }),
        ).toEqual({ number: 4, seq: 2 });
        expect((await harness.server.web("GET", "/sessions")).body).toMatchObject({
          agents: [{ sessions: [{ status: { state: "working", note: "Resumed." } }] }],
        });
      }
    }

    // The operator's message naming as many pull requests and branches as it
    // may, each with the longest URL, more than the answer cap on its own.
    // Every release reads it within the cap, and one whose writes do not name
    // them, being older than they are, reads it without them.
    const url = (path: string) => `https://example.com/${path}/`.padEnd(maxUrlLength, "x");
    const named = await harness.operatorWrites(2, {
      text: "These.",
      pull_requests: Array.from({ length: maxLinks }, (_, i) => ({
        repo: "acme/website",
        number: i + 1,
        url: url(`pull/${i + 1}`),
      })),
      branches: Array.from({ length: maxLinks }, (_, i) => ({
        repo: "acme/website",
        branch: `fix/${i + 1}`,
        url: url(`tree/fix/${i + 1}`),
      })),
    });
    const linked = await bridge.call("thread_get", { thread: 2, after: named - 1 });
    expect(linked.isError).toBe(false);
    expect(Buffer.byteLength(linked.text)).toBeLessThanOrEqual(maxResultBytes);
    expect(linked.json).toMatchObject({ messages: [{ seq: named }] });
    if (!takes("thread_create", "pull_requests")) {
      const { messages, ...read } = linked.json as { messages: object[] };
      for (const answer of [read, ...messages]) {
        expect(answer).not.toHaveProperty("pull_requests");
        expect(answer).not.toHaveProperty("branches");
      }
    }

    // Pull requests and branches, in a release whose writes name them: a
    // replacement naming another drops the first from the thread's roll-up,
    // and the list finds the thread only by what its roll-up names.
    if (takes("thread_create", "pull_requests")) {
      const first = { repo: "acme/agention", number: 135, url: "https://example.com/pull/135" };
      const second = { repo: "acme/agention", number: 136 };
      const branch = { repo: "acme/agention", branch: "feat/links" };
      const { number } = await call("thread_create", {
        request_id: "compat-13",
        title: "Links",
        pull_requests: [first],
      });
      expect(
        await call("message_send", {
          thread: number,
          request_id: "compat-14",
          seen_through: 1,
          pull_requests: [second],
          branches: [branch],
          replaces: 1,
        }),
      ).toEqual({ number, seq: 2 });
      expect(await call("thread_get", { thread: number })).toMatchObject({
        messages: [
          { seq: 1, live: false, pull_requests: [first] },
          { seq: 2, pull_requests: [second], branches: [branch] },
        ],
        pull_requests: { links: [second], truncated: false },
        branches: { links: [branch], truncated: false },
      });
      if (takes("thread_list", "pull_request")) {
        expect(await numbers({ pull_request: "Acme/Agention#136" })).toEqual([number]);
        expect(await numbers({ pull_request: "acme/agention#135" })).toEqual([]);
        expect(await numbers({ branch: "acme/agention:feat/links" })).toEqual([number]);
      }
    }

    if (has("session_update")) {
      expect(
        await call("session_update", { state: "stopped", outcome: "completed", note: "Shipped." }),
      ).toMatchObject({ state: "stopped", outcome: "completed" });
    }
    expect([...called].sort()).toEqual(tools.map((tool) => tool.name).sort());
  });
});
