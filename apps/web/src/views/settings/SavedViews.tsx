import { refusedFilterNames, refusedFiltersOn, type SavedView } from "@wayfarerlabs/agention-api";
import { useId, useState } from "react";
import { request } from "../../api.ts";
import { ConfirmButton, Failure, Loadable, useFocusWhenShown } from "../../components.tsx";
import { useAction, useResource } from "../../data.ts";
import { Link, listHref } from "../../router.tsx";
import { loadNotifications } from "../../push/subscription.ts";
import { loadSavedViews } from "../../saved-views.ts";
import { focusNext, NameForm } from "./Organizer.tsx";
import type { SectionProps } from "./sections.ts";

// Settings' saved views: every view, by name, each linking to its list, with
// Notify, which says whether an agent's message in a thread its list keeps
// notifies the operator's devices, Rename, which opens a field for its new
// name in its place, and Remove, which asks first, saying when it ends the
// view's notifying, or that it may while which views notify is unknown, and
// leaves every list and thread as it was, focus moving to the view after it,
// or to the section's heading once none is left. A failure to read which
// views notify is shown above the list, with a retry.
// Views are saved, and their lists replaced, from the thread list's Saved
// views.
export function SavedViewsSection({ focusHeading }: SectionProps) {
  const id = useId();
  const views = useResource(loadSavedViews);
  const notifications = useResource(loadNotifications);
  const notifying = notifications.data?.notifying;
  const focus = useFocusWhenShown(views.data);
  const rowOf = (view: SavedView) => `${id}-row-${view.id}`;
  return (
    <>
      <Failure failure={notifications.failure} action="Reading which views notify">
        <button type="button" className="secondary" onClick={() => void notifications.refresh()}>
          Try again
        </button>
      </Failure>
      <Loadable data={views.data} failure={views.failure} retry={() => void views.refresh()}>
        {({ views: all }) =>
          all.length === 0 ? (
            <p className="muted">
              No saved views yet. Save one from the thread list's <Link to="/">Saved views</Link>.
            </p>
          ) : (
            <ul className="organizer">
              {all.map((view, index) => (
                <SavedViewRow
                  key={view.id}
                  view={view}
                  notifies={notifying?.includes(view.id)}
                  rowId={rowOf(view)}
                  refresh={() => void views.refresh()}
                  refreshNotifying={() => void notifications.refresh()}
                  onRenamed={() => focus(`${rowOf(view)}-rename`)}
                  onRemoved={() =>
                    all.length === 1 ? focusHeading() : focusNext(all.map(rowOf), index, "")
                  }
                />
              ))}
            </ul>
          )
        }
      </Loadable>
    </>
  );
}

// removeQuestion is Remove's question, which says when removing a view ends
// its notifying, and hedges while which views notify is unknown.
function removeQuestion(view: SavedView, notifies: boolean | undefined): string {
  const notifying =
    notifies === undefined
      ? " If it notifies, removing it ends its notifying."
      : notifies
        ? " It notifies, and removing it ends its notifying."
        : "";
  return `Remove the saved view ${view.name}?${notifying} Every list and thread stays as it is.`;
}

// NotifySwitch turns a view's notifying on or off. A view with a filter on
// that cannot notify has it off, saying which.
function NotifySwitch({
  view,
  notifies,
  refresh,
}: {
  view: SavedView;
  // Whether it notifies, unknown until the section has read it.
  notifies: boolean | undefined;
  refresh: () => void;
}) {
  const id = useId();
  const action = useAction();
  const [refused] = refusedFiltersOn(view.view);
  const change = async (on: boolean) => {
    await action.run((csrf) =>
      on
        ? request("POST", "/notifications/views", { csrf, body: { view: view.id } })
        : request("POST", `/notifications/views/${view.id}/remove`, { csrf }),
    );
    refresh();
  };
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={notifies === true}
          disabled={notifies === undefined || refused !== undefined || action.pending}
          aria-describedby={refused === undefined ? undefined : `${id}-refused`}
          onChange={(event) => void change(event.target.checked)}
        />
        Notify
      </label>
      {refused !== undefined && (
        <p className="hint" id={`${id}-refused`}>
          Cannot notify while its {refusedFilterNames[refused]} filter is on.
        </p>
      )}
      <Failure failure={action.failure} />
    </>
  );
}

// SavedViewRow is one view in Settings' list: its name, linking to its list,
// Rename and Remove. A change under way leaves the controls where they are,
// focus with them, and takes no other.
function SavedViewRow({
  view,
  notifies,
  rowId,
  refresh,
  refreshNotifying,
  onRenamed,
  onRemoved,
}: {
  view: SavedView;
  notifies: boolean | undefined;
  // The id of its line, which focus can be put on; its Rename is the id with
  // -rename after it.
  rowId: string;
  refresh: () => void;
  refreshNotifying: () => void;
  // Moves focus on once it is renamed, to its Rename.
  onRenamed: () => void;
  // Moves focus on once it is removed, its own controls gone with it.
  onRemoved: () => void;
}) {
  const action = useAction();
  const [renaming, setRenaming] = useState(false);
  const path = `/saved-views/${view.id}`;
  const rename = async (name: string) => {
    const done = await action.run((csrf) =>
      request("POST", `${path}/name`, { csrf, body: { name } }),
    );
    refresh();
    if (done === undefined) {
      return false;
    }
    setRenaming(false);
    onRenamed();
    return true;
  };
  const remove = async () => {
    const done = await action.run((csrf) => request("POST", `${path}/remove`, { csrf }));
    if (done !== undefined) {
      onRemoved();
    }
    refresh();
    refreshNotifying();
  };
  return (
    <li>
      <article
        id={rowId}
        tabIndex={-1}
        className="organized"
        aria-label={`Saved view ${view.name}`}
      >
        <div className="organized-line">
          <Link to={listHref(view.view)}>{view.name}</Link>
        </div>
        <NotifySwitch view={view} notifies={notifies} refresh={refreshNotifying} />
        {renaming ? (
          <NameForm
            kind="view"
            label="New name"
            start={view.name}
            submitLabel="Save"
            done={rename}
            onCancel={() => {
              setRenaming(false);
              action.clear();
              onRenamed();
            }}
          />
        ) : (
          <div className="actions">
            <button
              id={`${rowId}-rename`}
              type="button"
              className="secondary"
              onClick={() => setRenaming(true)}
            >
              Rename
            </button>
            <ConfirmButton
              label="Remove"
              confirmLabel="Remove this view"
              question={removeQuestion(view, notifies)}
              disabled={action.pending}
              onConfirm={() => void remove()}
            />
          </div>
        )}
        <Failure failure={action.failure} />
      </article>
    </li>
  );
}
