import { maxListed } from "@wayfarerlabs/agention-api";
import {
  type FocusEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { describeFailure } from "./api.ts";
import { Icon } from "./icons.tsx";
import { serverName } from "./server-name.ts";

// Pieces the views share.

// usePageTitle names the page in the browser's tab and history, followed by
// the server's name, as in "Threads · Work".
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · ${serverName()}`;
  }, [title]);
}

// PageHeading is the view's one level-one heading. The shell moves focus to it
// after each navigation, so a screen reader announces the new page. A page
// whose tab in the navigation names it on screen keeps its heading for
// assistive technology alone, visuallyHidden.
export function PageHeading({
  visuallyHidden = false,
  children,
}: {
  visuallyHidden?: boolean;
  children: ReactNode;
}) {
  return (
    <h1 tabIndex={-1} className={visuallyHidden ? "visually-hidden" : undefined}>
      {children}
    </h1>
  );
}

// The parts of where a thread is: its agent, its session and its topic.
export type PathKind = "agent" | "session" | "topic";

// What marks each part for the eye, a letter, and the word it is said in.
const pathKinds: Record<PathKind, { letter: string; word: string }> = {
  agent: { letter: "A", word: "Agent" },
  session: { letter: "S", word: "Session" },
  topic: { letter: "T", word: "Topic" },
};

// pathWord is the word a part of where a thread is is said in, such as
// "Agent".
export const pathWord = (kind: PathKind) => pathKinds[kind].word;

// PathBadge marks a part of where a thread is for the eye alone: a tinted
// square holding its letter, A, S or T, which hovering names. A space sets it
// apart from what follows, which says the word for assistive technology.
export function PathBadge({ kind }: { kind: PathKind }) {
  const { letter, word } = pathKinds[kind];
  return (
    <span className="path-badge" aria-hidden="true" title={word}>
      {letter}
    </span>
  );
}

// PathPart is one part of where a thread is: its badge, then its name, said
// as "Agent builder".
export function PathPart({ kind, children }: { kind: PathKind; children: ReactNode }) {
  return (
    <span className="path-part">
      <PathBadge kind={kind} />
      <span className="visually-hidden">{pathWord(kind)}</span>{" "}
      <span className="path-name">{children}</span>
    </span>
  );
}

// Where threads are, as the parts of it shown: each kind with its name.
export type Place = [PathKind, string][];

// placeOf gives where a thread is: its agent, its session and its topic.
export function placeOf(thread: {
  agent: string;
  session: string;
  topic?: string | undefined;
}): Place {
  const place: Place = [
    ["agent", thread.agent],
    ["session", thread.session],
  ];
  return thread.topic === undefined ? place : [...place, ["topic", thread.topic]];
}

// PathParts shows the parts of where threads are, one after another.
export function PathParts({ place }: { place: Place }) {
  return place.map(([kind, name], index) => (
    <Fragment key={kind}>
      {index > 0 && " "}
      <PathPart kind={kind}>{name}</PathPart>
    </Fragment>
  ));
}

// ThreadTitle is a thread's title as its heading shows it, led by its number,
// muted, as in "#9 Release checklist".
export function ThreadTitle({ thread }: { thread: { number: number; title: string } }) {
  return (
    <>
      <span className="thread-number">#{thread.number}</span> {thread.title}
    </>
  );
}

// LeftOut says, in one line beside a list, that it left some of its items
// out, past the most a list that comes whole holds, naming what it lists, as
// in "agents".
export function LeftOut({ items }: { items: string }) {
  return (
    <p className="muted">
      Only the first {maxListed} {items} are listed.
    </p>
  );
}

// Failure shows why something did not work, announced as it appears.
export function Failure({ failure, children }: { failure: unknown; children?: ReactNode }) {
  if (failure === undefined) {
    return null;
  }
  return (
    <div className="notice danger" role="alert">
      <p>{describeFailure(failure)}</p>
      {children}
    </div>
  );
}

// Loadable shows a resource's state until its data arrives, then its content.
// A failed refresh keeps the content and says so above it.
export function Loadable<T>({
  data,
  failure,
  retry,
  children,
}: {
  data: T | undefined;
  failure: unknown;
  retry: () => void;
  children: (data: T) => ReactNode;
}) {
  const problem = failure !== undefined && (
    <Failure failure={failure}>
      <button type="button" className="secondary" onClick={retry}>
        Try again
      </button>
    </Failure>
  );
  if (data === undefined) {
    return problem || <p className="muted">Loading…</p>;
  }
  return (
    <>
      {problem}
      {children(data)}
    </>
  );
}

// Status announces the outcome of an action, politely, where it was taken.
export function Status({ children }: { children: ReactNode }) {
  return (
    <p className="status" role="status">
      {children}
    </p>
  );
}

// Confirmation asks once more before an action that cannot be undone: the
// question, a button that confirms and Cancel. Focus moves to the confirming
// button as it appears; where it goes once answered is the caller's to say.
export function Confirmation({
  question,
  confirmLabel,
  disabled,
  onConfirm,
  onCancel,
}: {
  question: string;
  confirmLabel: string;
  disabled?: boolean | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  return (
    <div className="confirm" role="group" aria-label={question}>
      <p>{question}</p>
      <div className="actions">
        <button
          ref={confirm}
          type="button"
          className="danger"
          disabled={disabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ConfirmButton asks once more before an action that cannot be undone. Focus
// moves to the confirming button when it asks, and back when it stops asking.
export function ConfirmButton({
  label,
  confirmLabel,
  question,
  disabled,
  describedBy,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  question: string;
  disabled?: boolean;
  // What says why the button is unavailable, when it is.
  describedBy?: string | undefined;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asking) {
      asked.current = true;
    } else if (asked.current) {
      opener.current?.focus();
    }
  }, [asking]);
  if (!asking) {
    return (
      <button
        ref={opener}
        type="button"
        className="secondary"
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <Confirmation
      question={question}
      confirmLabel={confirmLabel}
      disabled={disabled}
      onConfirm={() => {
        setAsking(false);
        onConfirm();
      }}
      onCancel={() => setAsking(false)}
    />
  );
}

// Tags lists what stands out about something, each with a tone.
export function Tags({ tags }: { tags: { label: ReactNode; tone?: string | undefined }[] }) {
  return (
    <ul className="tags">
      {tags.map((tag, index) => (
        <li key={index} className={tag.tone}>
          {tag.label}
        </li>
      ))}
    </ul>
  );
}

// MoreButton loads the next page of a list.
export function MoreButton({
  next,
  loading,
  more,
}: {
  next: string | undefined;
  loading: boolean;
  more: () => void;
}) {
  if (next === undefined) {
    return null;
  }
  return (
    <button type="button" className="secondary more" disabled={loading} onClick={more}>
      Show more
    </button>
  );
}

// The heading levels a fold's header can sit at.
export type FoldLevel = 2 | 3 | 4 | 5;

// How deep a fold sits among those holding it: outer, a tinted bar that stays
// at the top while its group scrolls under it; inner, a light subheader; or
// innermost, a quieter subheader still, for a third level of folds.
export type FoldDepth = "outer" | "inner" | "innermost";

const foldClasses: Record<FoldDepth, [section: string, head: string]> = {
  outer: ["group", "group-head"],
  inner: ["subgroup", "subgroup-head"],
  innermost: ["subgroup innermost", "subgroup-head"],
};

// Fold is what a header folds: a heading wrapping a disclosure button, its
// chevron turned while folded, and beneath it what it holds, shown only while
// unfolded, so nothing folded away loads or reads. Its depth sets its
// header's style. Its button shows its label and any marks beside it, and is
// named spoken where the marks say more than the label. actions, when given,
// sit beside the heading rather than in it, such as an options menu.
export function Fold({
  level,
  depth,
  label,
  marks,
  spoken,
  actions,
  folded,
  toggle,
  children,
}: {
  level: FoldLevel;
  depth: FoldDepth;
  label: ReactNode;
  marks?: ReactNode;
  spoken?: string | undefined;
  actions?: ReactNode;
  folded: boolean;
  toggle: () => void;
  children: ReactNode;
}) {
  const body = useId();
  const Heading = `h${level}` as const;
  const [section, head] = foldClasses[depth];
  const heading = (
    <Heading className={head}>
      <button
        type="button"
        aria-expanded={!folded}
        aria-controls={body}
        aria-label={spoken}
        onClick={toggle}
      >
        <Icon name="expand" />
        <span className="group-label">{label}</span>
        {marks}
      </button>
    </Heading>
  );
  return (
    <section className={section}>
      {actions === undefined ? (
        heading
      ) : (
        <div className="fold-head">
          {heading}
          {actions}
        </div>
      )}
      <div id={body} hidden={folded}>
        {!folded && children}
      </div>
    </section>
  );
}

// An options menu's way to close as an item is chosen.
const MenuChoice = createContext<() => void>(() => {});

// OptionsMenu is a button of three dots and the short menu of items it
// discloses below it, over what follows. Escape, choosing an item, a tap
// elsewhere, or focus moving on to another control closes it. Focus returns
// to the button, without scrolling to it, unless it went to that control or
// the tap landed on one. Choosing an item returns focus before the item acts,
// so an item that opens something, such as a sheet or a question, takes focus
// on to it. notes follow the items, such as why one waits. button, when
// given, is the caller's hold on the button, for focus to come back to later.
export function OptionsMenu({
  label,
  open,
  setOpen,
  button,
  notes,
  children,
}: {
  label: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  button?: RefObject<HTMLButtonElement | null>;
  notes?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLButtonElement>(null);
  const opener = button ?? own;
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const shut = useCallback(() => setOpenRef.current(false), []);
  useTapOutside(open, root, opener, shut);
  const close = useCallback(() => {
    shut();
    opener.current?.focus({ preventScroll: true });
  }, [shut, opener]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  // Focus moving on to a control outside, as Tab past the last item does,
  // closes the menu so it never lies over that control. Focus a tap leaves on
  // a region that takes it only from script, such as the page's main region,
  // is the click's to settle.
  const onBlur = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (
      open &&
      next instanceof HTMLElement &&
      next.tabIndex >= 0 &&
      root.current?.contains(next) !== true
    ) {
      shut();
    }
  };
  return (
    <div
      className={open ? "options open" : "options"}
      ref={root}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <button
        ref={opener}
        type="button"
        className="options-button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="options" />
      </button>
      {open && (
        <div id={id} className="options-menu">
          <MenuChoice.Provider value={close}>
            <ul>{children}</ul>
          </MenuChoice.Provider>
          {notes}
        </div>
      )}
    </div>
  );
}

// MenuItem is an item of an options menu: choosing it closes the menu, focus
// returning to its button, and then does what the item does.
export function MenuItem({
  onChoose,
  disabled,
  describedBy,
  className,
  children,
}: {
  onChoose: () => void;
  disabled?: boolean | undefined;
  describedBy?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const close = useContext(MenuChoice);
  return (
    <li>
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => {
          close();
          onChoose();
        }}
      >
        {children}
      </button>
    </li>
  );
}

// onControl says whether a tap on target lands on a control or within one:
// something the browser puts in the tab order, or a label, which hands the
// tap to its control. Such a tap keeps whatever focus it gives, which is
// none on iOS Safari for a button, a radio button or a link, so focus cannot
// say where the tap landed.
function onControl(target: EventTarget | null): boolean {
  for (let node = target instanceof Node ? target : null; node !== null; node = node.parentNode) {
    if (
      node instanceof HTMLElement &&
      (node.tabIndex >= 0 || (node instanceof HTMLLabelElement && node.control !== null))
    ) {
      return true;
    }
  }
  return false;
}

// useTapOutside shuts what a button discloses, such as a message's options,
// when a tap lands outside root, which holds both. Focus returns to the
// button, without scrolling to it, unless the tap landed on a control.
export function useTapOutside(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  button: RefObject<HTMLElement | null>,
  shut: () => void,
): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) {
        return;
      }
      shut();
      if (!onControl(event.target)) {
        button.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open, root, button, shut]);
}
