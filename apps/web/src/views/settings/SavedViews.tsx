import type { SavedView } from "@wayfarerlabs/agention-api";
import { useId, useState } from "react";
import { request } from "../../api.ts";
import { ConfirmButton, Failure, Loadable, useFocusWhenShown } from "../../components.tsx";
import { useAction, useResource } from "../../data.ts";
import { Link, listHref } from "../../router.tsx";
import { loadSavedViews } from "../../saved-views.ts";
import { focusNext, NameForm } from "./Organizer.tsx";
import type { SectionProps } from "./sections.ts";

// Settings' saved views: every view, by name, each linking to its list, with
// Rename, which opens a field for its new name in its place, and Remove,
// which asks first and leaves every list and thread as it was, focus moving
// to the view after it, or to the section's heading once none is left.
// Views are saved, and their lists replaced, from the thread list's Saved
// views.
export function SavedViewsSection({ focusHeading }: SectionProps) {
  const id = useId();
  const views = useResource(loadSavedViews);
  const focus = useFocusWhenShown(views.data);
  const rowOf = (view: SavedView) => `${id}-row-${view.id}`;
  return (
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
                rowId={rowOf(view)}
                refresh={() => void views.refresh()}
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
  );
}

// SavedViewRow is one view in Settings' list: its name, linking to its list,
// Rename and Remove. A change under way leaves the controls where they are,
// focus with them, and takes no other.
function SavedViewRow({
  view,
  rowId,
  refresh,
  onRenamed,
  onRemoved,
}: {
  view: SavedView;
  // The id of its line, which focus can be put on; its Rename is the id with
  // -rename after it.
  rowId: string;
  refresh: () => void;
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
              question={`Remove the saved view ${view.name}? Every list and thread stays as it is.`}
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
