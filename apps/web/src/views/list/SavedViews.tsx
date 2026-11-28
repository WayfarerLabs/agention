import {
  refusedFilterNames,
  refusedFiltersOn,
  type SavedView,
  type SavedViewList,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import { useId, useRef, useState } from "react";
import { request } from "../../api.ts";
import { ConfirmButton, Failure, Loadable, Sheet, useFocusWhenShown } from "../../components.tsx";
import { type Resource, useAction, useResource } from "../../data.ts";
import { Icon } from "../../icons.tsx";
import { loadNotifications } from "../../push/subscription.ts";
import { Link, listHref, navigate } from "../../router.tsx";
import { NameForm } from "../settings/Organizer.tsx";

// The Saved views sheet, which the list's head opens, as Filters opens its
// own: a sheet from the bottom on a phone, a panel on a wide screen. It
// lists the views by name, each a link to its list, those whose list is on
// screen checked, as a picker marks its choice, and each other offering to
// take the list on screen in place of its own, which asks first, saying when
// that ends the view's notifying, or that it may while which views notify is
// unknown. Beneath
// them, Save as new view names the list on screen, and Manage saved views
// opens Settings' section. Opening a view goes to its list's address, a new
// history entry as any link to a list makes, and closes the sheet; nothing
// else changes a view's list.

export function SavedViewsSheet({
  views,
  shown,
  current,
  onClose,
}: {
  views: Resource<SavedViewList>;
  // The list on screen.
  shown: ThreadsView;
  // The views whose list is the one on screen (currentViews).
  current: readonly SavedView[];
  onClose: () => void;
}) {
  const id = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const action = useAction();
  const [saving, setSaving] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const focus = useFocusWhenShown(views.data);
  // Which views notify, for Replace's question, which hedges while that is
  // unknown.
  const notifications = useResource(loadNotifications);
  const [refused] = refusedFiltersOn(shown);
  const replaceQuestion = (view: SavedView) => {
    const notifies = notifications.data?.notifying.includes(view.id);
    const filter = refused === undefined ? "" : `its ${refusedFilterNames[refused]} filter on`;
    const notifying =
      refused === undefined || notifies === false
        ? ""
        : notifies === undefined
          ? ` The list on screen has ${filter}, so if the view notifies, replacing it ends its notifying.`
          : ` It notifies, and the list on screen has ${filter}, so replacing it ends its notifying.`;
    return `Replace the list of ${view.name} with the list on screen?${notifying}`;
  };
  const linkOf = (view: SavedView) => `${id}-view-${view.id}`;
  const close = () => sheet.current?.close();
  const replace = async (view: SavedView) => {
    const done = await action.run((csrf) =>
      request("POST", `/saved-views/${view.id}/view`, { csrf, body: { view: shown } }),
    );
    // A failure may come of the view having changed or gone, so the list is
    // read again either way, as Settings' Rename does.
    await views.refresh();
    void notifications.refresh();
    if (done !== undefined) {
      focus(linkOf(view));
    }
  };
  const save = async (name: string) => {
    const made = await action.run((csrf) =>
      request<SavedView>("POST", "/saved-views", { csrf, body: { name, view: shown } }),
    );
    if (made === undefined) {
      return false;
    }
    setSaving(false);
    await views.refresh();
    focus(linkOf(made));
    return true;
  };
  return (
    <Sheet
      sheet={sheet}
      heading="Saved views"
      onClose={onClose}
      foot={
        <>
          <Link to="/settings/saved-views" className="sheet-link">
            Manage saved views
          </Link>
          <button type="button" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <Loadable data={views.data} failure={views.failure} retry={() => void views.refresh()}>
        {({ views: all }) =>
          all.length === 0 ? (
            <p className="muted">No saved views yet. Save the list on screen as one below.</p>
          ) : (
            <ul className="saved-views">
              {all.map((view) => {
                const isCurrent = current.some((each) => each.id === view.id);
                const href = listHref(view.view);
                return (
                  <li key={view.id}>
                    <div className="saved-view-line">
                      <span className="saved-view-check">{isCurrent && <Icon name="check" />}</span>
                      <Link
                        id={linkOf(view)}
                        to={href}
                        aria-current={isCurrent ? "true" : undefined}
                        follow={() => {
                          close();
                          navigate(href);
                        }}
                      >
                        {view.name}
                      </Link>
                    </div>
                    {!isCurrent && (
                      <ConfirmButton
                        label="Replace with this list"
                        confirmLabel="Replace"
                        question={replaceQuestion(view)}
                        disabled={action.pending}
                        onConfirm={() => void replace(view)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loadable>
      <Failure failure={action.failure} />
      {saving ? (
        <NameForm
          kind="view"
          label="New view's name"
          start=""
          submitLabel="Save view"
          done={save}
          onCancel={() => {
            setSaving(false);
            action.clear();
            requestAnimationFrame(() => saveButton.current?.focus());
          }}
        />
      ) : (
        <button
          ref={saveButton}
          type="button"
          className="secondary"
          onClick={() => setSaving(true)}
        >
          Save as new view
        </button>
      )}
    </Sheet>
  );
}

// The head button's name: Saved views, and the current views' names, as
// Search's name says the search on.
export function savedViewsName(current: readonly SavedView[]): string {
  return current.length === 0
    ? "Saved views"
    : `Saved views, ${current.map((each) => each.name).join(", ")}`;
}
