import type { MouseEvent, ReactNode, RefObject } from "react";
import { useScrollClearOf } from "./components.tsx";
import { type IconName, Icon } from "./icons.tsx";
import { Link } from "./router.tsx";

// The bars at the foot of a pane, which act on what the pane shows: the
// thread list's and the thread page's. Each is a labelled region, last in its
// pane, docked to the foot of the screen while its pane scrolls beneath it,
// on the surface of the composer's Send row. It holds a row of buttons, each
// an icon over a short label, the full name of what it does its accessible
// name. A button keeps its place, disabled there while it cannot act, so a
// second press in the same spot never does something else. A caption says
// what the buttons act on, or what the last of them did. While a text field
// in its pane has focus, and for the thread's bar on a very short screen, the
// bar rests at the end of its pane in place of floating (styles.css,
// .action-bar).

// ActionBar is a bar, named by label: bar is the caller's hold on it, and
// height the root's property that holds how tall it is, which the page's
// scroll padding keeps clear, so what a key moves focus to scrolls into view
// above it, and which the thread's Send row stands above.
export function ActionBar({
  label,
  height,
  bar,
  children,
}: {
  label: string;
  height: string;
  bar: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  useScrollClearOf(bar, height);
  return (
    <section ref={bar} aria-label={label} className="action-bar">
      {children}
    </section>
  );
}

// BarCaption says what a bar's buttons act on, or what the last of them did:
// beside them where it fits, or on a line of its own above them; a reason a
// button waits reads muted.
export function BarCaption({
  ownLine = false,
  reason = false,
  children,
  ...rest
}: {
  ownLine?: boolean;
  reason?: boolean;
  id?: string;
  hidden?: boolean;
  "aria-hidden"?: boolean;
  children: ReactNode;
}) {
  const className = ["bar-caption", ownLine && "own-line", reason && "reason"]
    .filter(Boolean)
    .join(" ");
  return (
    <p className={className} {...rest}>
      {children}
    </p>
  );
}

// BarSlots holds a bar's buttons, in equal columns, as a group named by
// group when given.
export function BarSlots({ group, children }: { group?: string; children: ReactNode }) {
  return (
    <div className="bar-slots" role={group === undefined ? undefined : "group"} aria-label={group}>
      {children}
    </div>
  );
}

// What a bar's button or link shows and is: its icon and short label, its
// full name where that says more, and whether it leads the bar's trailing
// group, which stands at the bar's end.
interface BarControl {
  icon: IconName;
  label: string;
  name?: string;
  trailing?: boolean;
}

const classOf = ({ trailing = false }: BarControl) =>
  trailing ? "bar-button trailing" : "bar-button";

function Face({ icon, label }: BarControl) {
  return (
    <>
      <Icon name={icon} />
      <span className="bar-label">{label}</span>
    </>
  );
}

// BarButton is a bar's button. One that cannot act is disabled; one that
// waits on something the operator must do first names the element saying
// why (waitsOn) instead, which makes it unavailable (aria-disabled) and
// describes it, so it keeps focus and a press can show why.
export function BarButton({
  disabled = false,
  waitsOn,
  action,
  onClick,
  ...control
}: BarControl & {
  disabled?: boolean;
  waitsOn?: string | undefined;
  action?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={classOf(control)}
      aria-label={control.name}
      disabled={disabled}
      aria-disabled={waitsOn === undefined ? undefined : true}
      aria-describedby={waitsOn}
      data-action={action}
      onClick={onClick}
    >
      <Face {...control} />
    </button>
  );
}

// BarLink is a bar's link, to another page.
export function BarLink({ to, ...control }: BarControl & { to: string }) {
  return (
    <Link to={to} className={classOf(control)} aria-label={control.name}>
      <Face {...control} />
    </Link>
  );
}
