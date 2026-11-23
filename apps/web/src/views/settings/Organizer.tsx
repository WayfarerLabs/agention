import {
  type Color,
  colors,
  groupName,
  type ThreadsView,
  tagName,
} from "@wayfarerlabs/agention-api";
import {
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { request } from "../../api.ts";
import { ConfirmButton, Failure } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { Icon } from "../../icons.tsx";
import { colorName, nameKey, nameProblem, OrganizedChip } from "../../organizing.tsx";
import { FilterLink } from "../filter-links.tsx";

// The parts Settings' lists of groups and of tags share: a list's head, with
// its search box and New; the form that names a group or a tag; and one group
// or tag in its list, with what it holds, Rename, its color and Remove.

// useSearch gives a list's search box, and the words it narrows the list to.
export function useSearch(label: string): [ReactNode, string] {
  const [text, setText] = useState("");
  return [
    <input
      type="search"
      aria-label={label}
      placeholder={label}
      value={text}
      onChange={(event) => setText(event.target.value)}
    />,
    nameKey(text.trim()),
  ];
}

// useFocusWhenShown puts focus on an element by its id as soon as it shows,
// which a change can take a render or a reload to bring, as a tag renamed
// shows under its new name once the list reloads. The list's next reload,
// a new shown, ends the wait whether the element came or not, so a stale
// one never takes focus later.
export function useFocusWhenShown(shown: unknown): (id: string) => void {
  const [wanted, setWanted] = useState<{ id: string; shown: unknown }>();
  // What shows now, for a wait asked for from a callback made before it.
  const now = useRef(shown);
  now.current = shown;
  useLayoutEffect(() => {
    if (wanted === undefined) {
      return;
    }
    const element = document.getElementById(wanted.id);
    if (element !== null || wanted.shown !== shown) {
      setWanted(undefined);
      element?.focus();
    }
  });
  return (id) => setWanted({ id, shown: now.current });
}

// focusNext puts focus, once a row of a list is removed, on the row after
// it, or the one before when it was last, or on the list's New when it was
// alone.
export function focusNext(rows: string[], removed: number, fallback: string) {
  const next = rows[removed + 1] ?? rows[removed - 1] ?? fallback;
  document.getElementById(next)?.focus();
}

// NameField is a form's one field for a name, with why it cannot be used.
function NameField({
  label,
  value,
  onChange,
  problem,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  problem: string | undefined;
  maxLength: number;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => field.current?.focus(), []);
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input
        ref={field}
        id={id}
        value={value}
        maxLength={maxLength}
        autoCapitalize="none"
        aria-invalid={problem === undefined ? undefined : true}
        aria-describedby={problem === undefined ? undefined : `${id}-error`}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem !== undefined && (
        <p id={`${id}-error`} className="field-error">
          {problem}
        </p>
      )}
    </>
  );
}

// How a group's or a tag's name is typed: a group's as written, trimmed, and
// a tag's in lowercase, as the API takes each.
const typedName = (kind: "group" | "tag", value: string) =>
  kind === "group" ? value.trim() : value.trim().toLowerCase();

// NameForm names a group or a tag, new or renamed, with the API's rule for
// the name, and Save and Cancel; done says whether it took the name.
function NameForm({
  kind,
  label,
  start,
  submitLabel,
  done,
  onCancel,
}: {
  kind: "group" | "tag";
  label: string;
  start: string;
  submitLabel: string;
  done: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(start);
  const [shown, setShown] = useState(false);
  const typed = typedName(kind, value);
  const problem = nameProblem(kind === "group" ? groupName : tagName, "name", typed);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShown(true);
    if (problem === undefined && (await done(typed))) {
      setValue("");
      setShown(false);
    }
  };
  return (
    <form className="name-form" noValidate onSubmit={(event) => void submit(event)}>
      <NameField
        label={label}
        value={value}
        onChange={setValue}
        problem={shown || value !== start ? problem : undefined}
        maxLength={kind === "group" ? 100 : 63}
      />
      <div className="actions">
        <button type="submit">{submitLabel}</button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ListHead is a list's head: its heading, its search box and New, which
// opens a form naming one to create, in its place, until it is done or
// cancelled.
export function ListHead({
  heading,
  headingId,
  newId,
  kind,
  search,
  create,
  full,
}: {
  heading: string;
  headingId: string;
  // The id of New, which focus can be put on.
  newId: string;
  kind: "group" | "tag";
  search: ReactNode;
  create: (name: string) => Promise<boolean>;
  // Why New is unavailable, when it is.
  full?: string | undefined;
}) {
  const id = useId();
  const [creating, setCreating] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const stop = () => {
    setCreating(false);
    requestAnimationFrame(() => opener.current?.focus());
  };
  return (
    <>
      <h3 id={headingId}>{heading}</h3>
      <div className="organizer-head">
        {search}
        {!creating && (
          <button
            ref={opener}
            id={newId}
            type="button"
            disabled={full !== undefined}
            aria-describedby={full === undefined ? undefined : `${id}-full`}
            onClick={() => setCreating(true)}
          >
            New {kind}
          </button>
        )}
      </div>
      {full !== undefined && (
        <p id={`${id}-full`} className="muted">
          {full}
        </p>
      )}
      {creating && (
        <NameForm
          kind={kind}
          label={`New ${kind}'s name`}
          start=""
          submitLabel={`Create ${kind}`}
          done={async (name) => {
            const made = await create(name);
            if (made) {
              stop();
            }
            return made;
          }}
          onCancel={stop}
        />
      )}
    </>
  );
}

// HoldsLink says what a group or a tag holds, linking to those threads on
// the thread list, as its chip does, named by what it shows and what holds
// them, such as "3 sessions in group Billing".
export function HoldsLink({
  narrowing,
  words,
  of,
}: {
  narrowing: Partial<ThreadsView>;
  words: string;
  of: string;
}) {
  return (
    <FilterLink className="organized-holds" narrowing={narrowing} spoken={`${words} ${of}`}>
      {words}
    </FilterLink>
  );
}

// A group's drag by its handle: starting and ending it, and dropping another
// group on this one.
export interface Drag {
  start: () => void;
  end: () => void;
  drop: (event: DragEvent) => void;
}

// Organized is one group or tag in its list: its chip and what it holds,
// with Rename, which opens a field for its new name in its place, its color,
// which applies as it is chosen, and Remove, which asks first. A change
// under way leaves the controls where they are, focus with them, and takes
// no other. A group also has its moves, and a handle a mouse drags it by
// while it can move.
export function Organized({
  kind,
  name,
  color,
  path,
  holds,
  removing,
  refresh,
  rowId,
  onRenamed,
  onRemoved,
  moves,
  drag,
  dragging = false,
}: {
  kind: "group" | "tag";
  name: string;
  color: Color;
  // The API path of the group or tag.
  path: string;
  holds: ReactNode;
  // The question Remove asks.
  removing: string;
  refresh: () => void;
  // The id of its line, which focus can be put on; its Rename is the id
  // with -rename after it.
  rowId: string;
  // Moves focus on once it is renamed, to its Rename under its new name.
  onRenamed: (name: string) => void;
  // Moves focus on once it is removed, its own controls gone with it.
  onRemoved: () => void;
  moves?: ReactNode;
  drag?: Drag | undefined;
  dragging?: boolean;
}) {
  const action = useAction();
  const [renaming, setRenaming] = useState(false);
  const [over, setOver] = useState(false);
  const article = useRef<HTMLElement>(null);
  const change = async (what: string, body: object) => {
    const done = await action.run((csrf) => request("POST", `${path}/${what}`, { csrf, body }));
    refresh();
    return done !== undefined;
  };
  const remove = async () => {
    const done = await action.run((csrf) => request("POST", `${path}/remove`, { csrf }));
    if (done !== undefined) {
      onRemoved();
      refresh();
    }
  };
  const label = kind === "group" ? `Group ${name}` : `Tag ${name}`;
  const classes = ["organized", dragging ? "dragging" : "", over ? "drop-over" : ""];
  return (
    <li
      onDragOver={(event) => {
        if (drag !== undefined) {
          event.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        drag?.drop(event);
      }}
    >
      <article
        ref={article}
        id={rowId}
        tabIndex={-1}
        className={classes.join(" ").trim()}
        aria-label={label}
      >
        <div className="organized-line">
          {drag !== undefined && (
            <span
              className="drag-handle"
              aria-hidden="true"
              title="Drag to move"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", name);
                if (article.current !== null) {
                  event.dataTransfer.setDragImage?.(article.current, 0, 0);
                }
                drag.start();
              }}
              onDragEnd={() => drag.end()}
            >
              <Icon name="grip" />
            </span>
          )}
          <OrganizedChip kind={kind} name={name} color={color} />
          {holds}
          {moves !== undefined && <span className="organized-moves">{moves}</span>}
        </div>
        {renaming ? (
          <NameForm
            kind={kind}
            label="New name"
            start={name}
            submitLabel="Save"
            done={async (typed) => {
              const done = await change("name", { name: typed });
              if (done) {
                setRenaming(false);
                onRenamed(typed);
              }
              return done;
            }}
            onCancel={() => {
              setRenaming(false);
              action.clear();
              onRenamed(name);
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
            <select
              aria-label={`Color of ${name}`}
              value={color}
              aria-disabled={action.pending || undefined}
              onChange={(event) => {
                if (!action.pending) {
                  void change("color", { color: event.target.value });
                }
              }}
            >
              {colors.map((each) => (
                <option key={each} value={each}>
                  {colorName[each]}
                </option>
              ))}
            </select>
            <ConfirmButton
              label="Remove"
              confirmLabel={`Remove this ${kind}`}
              question={removing}
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
