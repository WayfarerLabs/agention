import { maxListed } from "@wayfarerlabs/agention-api";
import {
  type FocusEvent,
  type FormEvent,
  Fragment,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { describeFailure } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { serverName } from "./server-name.ts";

// Pieces the views share.

// usePageTitle names the page in the browser's tab and history, followed by
// the server's name, as in "Threads · Work"; with no title, it leaves the
// name to another part of the page, as the thread list does to a thread
// open beside it.
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    if (title !== undefined) {
      document.title = `${title} · ${serverName()}`;
    }
  }, [title]);
}

// focusLanding moves focus to where a navigation lands on a page: the place
// a view marks with data-landing, on its heading or else the place itself,
// as side by side a thread's pane or the row of the thread just left; with
// none marked, the page's heading, or the page itself. A landing with no
// heading yet, as a thread's while it loads, stays pending until the first
// heading to show in it takes focus from it (PageHeading).
export function focusLanding(page: HTMLElement): void {
  const landing = page.querySelector<HTMLElement>("[data-landing]") ?? page;
  const heading = landing.querySelector<HTMLElement>("h1");
  (heading ?? landing).focus();
  pendingLanding = heading === null ? landing : undefined;
}

// The landing focusLanding last moved focus to with no heading in it.
let pendingLanding: HTMLElement | undefined;

// PageHeading is the view's one level-one heading, the thread's where the
// thread list stands beside it. The shell moves focus to it after each
// navigation, so a screen reader announces the new page. The first one to
// show in a landing focusLanding left pending takes focus as it shows, as a
// thread's does once it loads, but only while focus is still on that
// landing itself or on nothing, as when the control that had it went, never
// from where the operator has since put it, within the landing or not: a
// phone's landing is all of main, which the list beside the thread joins once
// the window widens. A page whose tab in the navigation names it on screen keeps
// its heading for assistive technology alone, visuallyHidden.
export function PageHeading({
  visuallyHidden = false,
  children,
}: {
  visuallyHidden?: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const landing = pendingLanding;
    const shown = heading.current;
    if (landing === undefined || shown === null || !landing.contains(shown)) {
      return;
    }
    pendingLanding = undefined;
    const focus = document.activeElement;
    if (focus === landing || focus === null || focus === document.body) {
      shown.focus();
    }
  }, []);
  return (
    <h1 ref={heading} tabIndex={-1} className={visuallyHidden ? "visually-hidden" : undefined}>
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

// useScrollClearOf keeps what the page scrolls into view, as the caret while
// typing or a control focused from the keyboard, clear of a bar stuck at the
// foot of the screen, such as the composer's Send row, however tall what it
// holds makes it: it gives the root's property the bar's height while the
// bar is shown, for the stylesheet's scroll padding.
export function useScrollClearOf(bar: RefObject<HTMLElement | null>, property: string): void {
  useEffect(() => {
    const element = bar.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty(property, `${element.offsetHeight}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(property);
    };
  }, [bar, property]);
}

// focusLeftWith says whether focus is where a pressed control left it: on
// nothing, as when that control was removed, or within one of the elements
// given. A control that replaces another moves focus to its successor only
// then, never away from where the operator has since put it.
export function focusLeftWith(...within: (Element | null | undefined)[]): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    within.some((element) => element?.contains(active) === true)
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
  useLayoutEffect(() => confirm.current?.focus(), []);
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
  useLayoutEffect(() => {
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

// What takes a drop, as a fold's head can: the handlers it takes one by.
export type DropProps = Pick<HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop">;

// What a fold's header is labelled: a plain label, which sits in the
// fold's button and names it; or, given the name the button goes by, as in
// "Agent builder", a label beside the button, which can be a link, such as to
// the threads it heads.
type FoldLabel = { name?: undefined; label: string } | { name: string; label: ReactNode };

// Fold is what a header folds: a bar holding a heading, then any marks,
// wrapping where the width ends, and any actions, kept together at the
// bar's right end, and beneath it what it holds, shown only while unfolded,
// so nothing folded away loads or reads. Its depth sets the bar's style. The
// heading leads with the fold's disclosure button, its chevron turned while
// folded, and goes by the button's name alone, so a linked label beside the
// button does not say it twice. The marks can hold links, and the actions
// controls, such as an options menu. The button stretches under the bar, so
// a click anywhere on it but on a link or a control folds or unfolds it, as
// on a plain label or a plain mark; keyboards and assistive technology use
// the button. A fold can take a class of its own beside its depth's, and
// what takes a drop on its head.
export function Fold({
  level,
  depth,
  marks,
  actions,
  folded,
  toggle,
  children,
  className,
  drop,
  ...labelled
}: FoldLabel & {
  level: FoldLevel;
  depth: FoldDepth;
  marks?: ReactNode;
  actions?: ReactNode;
  folded: boolean;
  toggle: () => void;
  children: ReactNode;
  className?: string | undefined;
  drop?: DropProps | undefined;
}) {
  const body = useId();
  const button = useId();
  const Heading = `h${level}` as const;
  const [section, head] = foldClasses[depth];
  const shown = <span className="group-label">{labelled.label}</span>;
  const plain = labelled.name === undefined;
  return (
    <section className={className === undefined ? section : `${section} ${className}`}>
      <div className="fold-head" {...drop}>
        <div className={head}>
          <div className="fold-main">
            <Heading className="fold-title" aria-labelledby={plain ? undefined : button}>
              <button
                type="button"
                id={button}
                className="fold-toggle"
                aria-expanded={!folded}
                aria-controls={body}
                aria-label={labelled.name}
                onClick={toggle}
              >
                <Icon name="expand" />
                {plain && shown}
              </button>
              {!plain && shown}
            </Heading>
            <span className="fold-end">{marks}</span>
          </div>
          {actions !== undefined && <span className="fold-actions">{actions}</span>}
        </div>
      </div>
      <div id={body} hidden={folded}>
        {!folded && children}
      </div>
    </section>
  );
}

// Sheet is a modal dialog rising from the bottom on a phone and a panel on a
// wide screen, as the filter sheet is, open from the moment it mounts with
// focus on its heading, so a phone's keyboard does not rise over it. Its body
// scrolls under its foot, and the two are one form when it submits; onClose
// runs once it closes, which closing sheet does.
export function Sheet({
  sheet,
  heading,
  onClose,
  onSubmit,
  foot,
  children,
  held = false,
}: {
  sheet: RefObject<HTMLDialogElement | null>;
  heading: string;
  onClose: () => void;
  // Whether the sheet holds still, as while what it sends is on its way:
  // Escape does not close it.
  held?: boolean;
  onSubmit?: (event: FormEvent) => void;
  foot: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    sheet.current?.showModal();
    title.current?.focus();
  }, [sheet]);
  const body = (
    <>
      <div className="sheet-body">
        <h2 id={`${id}-heading`} ref={title} tabIndex={-1}>
          {heading}
        </h2>
        {children}
      </div>
      <div className="sheet-foot">{foot}</div>
    </>
  );
  return (
    <dialog
      ref={sheet}
      className="sheet"
      aria-labelledby={`${id}-heading`}
      onClose={onClose}
      onCancel={(event) => {
        if (held) {
          event.preventDefault();
        }
      }}
      onKeyDown={(event) => {
        // A keydown's default is what makes Escape cancel the dialog, and
        // the browser may not let its cancel event be refused every time.
        if (held && event.key === "Escape") {
          event.preventDefault();
        }
      }}
    >
      {onSubmit === undefined ? (
        body
      ) : (
        <form className="sheet-form" noValidate onSubmit={onSubmit}>
          {body}
        </form>
      )}
    </dialog>
  );
}

// An options menu's way to close as an item is chosen.
const MenuChoice = createContext<() => void>(() => {});

// OptionsMenu is a button of three dots, or of icon, and the short menu of
// items it discloses over what is around it, below the button unless the
// stylesheet places it elsewhere, as it does Attach's. Escape, choosing an
// item, a tap elsewhere, or focus moving on to another control closes it.
// Focus returns to the button, without scrolling to it, unless it went to
// that control or the tap landed on one. Choosing an item returns focus
// before the item acts, so an item that opens something, such as a sheet or a
// question, takes focus on to it. notes follow the items, such as why one
// waits. button, when given, is the caller's hold on the button, for focus to
// come back to later. buttonClass lets the button look as the control the
// menu stands in for, such as Attach.
export function OptionsMenu({
  label,
  open,
  setOpen,
  button,
  icon = "options",
  buttonClass = "options-button",
  disabled,
  notes,
  children,
}: {
  label: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  button?: RefObject<HTMLButtonElement | null>;
  icon?: IconName;
  buttonClass?: string;
  disabled?: boolean;
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
        className={buttonClass}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Icon name={icon} />
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

// anyMenuOpen says whether an options menu is open on the page, which keeps
// the page's keyboard shortcuts from acting over it.
export const anyMenuOpen = () => document.querySelector(".options.open") !== null;

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

// useFocusWhenShown puts focus on an element by its id as soon as it shows,
// which a change can take a render or a reload to bring, as a tag renamed
// shows under its new name once its list reloads. The next shown, as the
// list reloads, ends the wait whether the element came or not, so a stale
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
