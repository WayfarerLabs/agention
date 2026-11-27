import type { AuditRecord } from "../cursors.ts";
import type { Sink } from "../dispatcher.ts";

// The stdout sink writes each event as a JSON line to standard output, for a
// platform's log pipeline, which agention serve writes nothing else to. Node
// writes to a pipe asynchronously, so a batch is delivered only once its write
// has drained to the stream; drained means handed on, not collected. A stream
// that fails also emits the error, which whoever owns the stream must hear;
// the sink answers by the write's callback.

// A stream a sink writes to, whose callback runs once the write has drained.
export interface LineStream {
  write(text: string, callback: (error?: Error | null) => void): unknown;
}

// lines writes a batch as JSON lines, each event's JSON as it was stored.
export const lines = (batch: readonly AuditRecord[]): string =>
  batch.map((record) => `${record.json}\n`).join("");

export function stdoutSink(stream: LineStream): Sink {
  return {
    kind: "stdout",
    deliver: (batch) =>
      new Promise<void>((resolve, reject) => {
        stream.write(lines(batch), (error) => {
          if (error === null || error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
    close: async () => undefined,
  };
}
