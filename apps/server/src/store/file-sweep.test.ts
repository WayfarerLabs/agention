import { pendingLifetime } from "@wayfarerlabs/agention-api";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepFilesRegularly, sweepInterval } from "./file-sweep.ts";
import { beginUpload, completeUpload } from "./files.ts";
import { type Agent, Fixture } from "./test-fixture.ts";

let fixture: Fixture;
let agent: Agent;
let logged: string[];
const log = (message: string) => logged.push(message);

beforeEach(() => {
  // Only the sweep's timer is fake: its vacuum steps yield on real turns.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
  logged = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fixture.close();
});

// expire leaves an upload no message names and moves the clock past its
// lifetime, so the next pass removes it.
function expire(): void {
  const upload = beginUpload(fixture.store, agent.identity, agent.target, {
    name: "a.txt",
    type: "text/plain",
    size: 0,
  });
  completeUpload(fixture.store, upload, 0, createHash("sha256").digest());
  fixture.advance(pendingLifetime);
}

const files = () =>
  (fixture.db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n;

// passes counts the sweep's passes from now, by their selection of what to
// remove.
function passes(): () => number {
  const prepare = vi.spyOn(fixture.db, "prepare");
  return () =>
    prepare.mock.calls.filter(([sql]) => /SELECT id FROM files WHERE attached_at IS NULL/.test(sql))
      .length;
}

describe("the sweep's schedule", () => {
  it("runs a pass at once, then one every interval until it stops", async () => {
    expire();
    const sweeps = sweepFilesRegularly(fixture.store, log);
    await sweeps.first;
    expect(files()).toBe(0);
    expire();
    await vi.advanceTimersByTimeAsync(sweepInterval - 1);
    expect(files()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(files()).toBe(0);
    await sweeps.stop();
    expire();
    await vi.advanceTimersByTimeAsync(sweepInterval * 2);
    expect(files()).toBe(1);
    expect(logged).toEqual([]);
  });

  it("never runs a second pass while one is under way, and stop awaits it", async () => {
    // A pass that keeps freeing pages keeps stepping until the test lets it
    // end.
    vi.spyOn(fixture.db, "incrementalVacuum", "get").mockReturnValue(true);
    vi.spyOn(fixture.db, "vacuumStep").mockImplementation(() => undefined);
    let free = Number.MAX_SAFE_INTEGER;
    const freePages = vi.spyOn(fixture.db, "freePages").mockImplementation(() => free--);
    const counted = passes();
    const sweeps = sweepFilesRegularly(fixture.store, log);
    let firstDone = false;
    void sweeps.first.then(() => (firstDone = true));
    await vi.advanceTimersByTimeAsync(sweepInterval * 3);
    expect([counted(), firstDone]).toEqual([1, false]);
    let stopped = false;
    const stopping = sweeps.stop().then(() => (stopped = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    freePages.mockReturnValue(0);
    await stopping;
    expect(firstDone).toBe(true);
    await vi.advanceTimersByTimeAsync(sweepInterval * 2);
    expect(counted()).toBe(1);
  });

  it("logs a pass that fails, and runs the next", async () => {
    expire();
    vi.spyOn(fixture.db, "transaction").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    const sweeps = sweepFilesRegularly(fixture.store, log);
    await sweeps.first;
    expect([logged.length, files()]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(sweepInterval);
    expect(files()).toBe(0);
    await sweeps.stop();
  });
});
