import { maxListed } from "@wayfarerlabs/agention-api";
import { Fragment, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { describeFailure } from "./api.ts";
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

// LeftOut says, in one line beside a choice, that the list it offers left
// some values out, past the most a list that comes whole holds.
export function LeftOut() {
  return <p className="muted">Only the first {maxListed} are listed.</p>;
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
  const confirm = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asking) {
      asked.current = true;
      confirm.current?.focus();
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
    <div className="confirm" role="group" aria-label={question}>
      <p>{question}</p>
      <div className="actions">
        <button
          ref={confirm}
          type="button"
          className="danger"
          disabled={disabled}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button type="button" className="secondary" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
    </div>
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
