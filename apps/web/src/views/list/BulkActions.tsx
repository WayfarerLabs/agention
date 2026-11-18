import {
  type BulkArchiveResult,
  type BulkMarkInput,
  type BulkReadResult,
  statusKept,
  type ThreadSummary,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import { request } from "../../api.ts";
import { Failure } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { plural } from "../../format.tsx";

// A bulk mark takes at most this many threads.
const markBatch = 100;

// marked lists threads as a bulk mark takes them, each through the latest
// message the list showed, so a message that arrived since stays unread and
// keeps its thread out of the archive.
function marked(threads: ThreadSummary[]): BulkMarkInput["threads"] {
  return threads.map((thread) => ({
    agent: thread.agent,
    session: thread.session,
    thread: thread.number,
    through: thread.last_seq,
  }));
}

// A bulk mark acts on the threads loaded, and says when more remain.
const remaining = (more: boolean, verb: string) =>
  more ? ` More threads remain: show more to ${verb} them too.` : "";

// BulkActions marks the threads loaded at once: Archive all read while
// archived threads are not included, skipping threads holding an open ask
// and saying so, and with Unread on, Mark all read. more says whether the
// list holds threads not loaded; say tells the list's status region what was
// done.
export function BulkActions({
  view,
  threads,
  more,
  refresh,
  say,
}: {
  view: ThreadsView;
  threads: ThreadSummary[];
  more: boolean;
  refresh: () => void;
  say: (text: string) => void;
}) {
  const action = useAction();

  const markAllRead = async () => {
    say("");
    const all = marked(threads);
    const done = await action.run(async (csrf) => {
      for (let start = 0; start < all.length; start += markBatch) {
        await request<BulkReadResult>("POST", "/reads", {
          csrf,
          body: { threads: all.slice(start, start + markBatch) } satisfies BulkMarkInput,
        });
      }
      return true;
    });
    if (done === true) {
      say(`Marked ${plural(threads.length, "thread")} read.${remaining(more, "mark")}`);
    }
    refresh();
  };

  const archiveAllRead = async () => {
    say("");
    const all = marked(threads.filter((thread) => thread.unread === 0));
    const done = await action.run(async (csrf) => {
      let archived = 0;
      let skipped = 0;
      for (let start = 0; start < all.length; start += markBatch) {
        const answer = await request<BulkArchiveResult>("POST", "/archives", {
          csrf,
          body: { threads: all.slice(start, start + markBatch) } satisfies BulkMarkInput,
        });
        archived += answer.archived.length;
        skipped += answer.skipped.length;
      }
      return { archived, skipped };
    });
    if (done !== undefined) {
      say(
        `Archived ${plural(done.archived, "thread")}.` +
          (done.skipped === 0
            ? ""
            : ` Kept ${plural(done.skipped, "thread")} with an ask open to you.`) +
          remaining(more, "archive"),
      );
    }
    refresh();
  };

  return (
    <>
      <Failure failure={action.failure} />
      {!view.include_archived &&
        statusKept(view) !== "open" &&
        threads.some((thread) => thread.unread === 0) && (
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={action.pending}
              onClick={() => void archiveAllRead()}
            >
              Archive all read
            </button>
          </div>
        )}
      {view.unread && threads.length > 0 && (
        <div className="actions">
          <button type="button" disabled={action.pending} onClick={() => void markAllRead()}>
            Mark all read
          </button>
        </div>
      )}
    </>
  );
}
