import {
  maxActionThreads,
  statusKept,
  type ThreadAction,
  type ThreadSummary,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import { Failure } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { actOn, outcome, targetsOf } from "./actions.ts";

// A bulk mark acts on the threads loaded, at most as many as one action
// takes, and says when more remain.
const remaining = (more: boolean, verb: string) =>
  more ? ` More threads remain: show more to ${verb} them too.` : "";

// BulkActions marks the threads loaded at once: Archive all read while
// archived threads are not included, marking read and archiving those
// holding nothing unread, keeping threads holding an open ask and saying so;
// and with Unread on, Mark all read. more says whether the list holds
// threads not loaded; say tells the list's status region what was done.
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

  const act = async (chosen: ThreadAction, acted: ThreadSummary[], verb: string) => {
    say("");
    const taken = acted.slice(0, maxActionThreads);
    const done = await action.run((csrf) => actOn(chosen, targetsOf(taken), csrf));
    if (done !== undefined) {
      say(outcome(chosen, done) + remaining(more || taken.length < acted.length, verb));
    }
    refresh();
  };
  const markAllRead = () => act("read", threads, "mark");
  const archiveAllRead = () =>
    act(
      "read_and_archive",
      threads.filter((thread) => thread.unread === 0),
      "archive",
    );

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
