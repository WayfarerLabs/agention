import type { ReactNode } from "react";
import { Spoken } from "./format.tsx";

// The app's icons, drawn on a 24-unit grid and stroked in the text's color.
// Each is decoration beside text or an accessible name its control carries,
// so it is hidden from assistive technology.

const shapes = {
  // A funnel, for the filters.
  filters: <path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" />,
  // Arrows up and down, for the order.
  sort: <path d="M7 4v16m-4-4 4 4 4-4M17 20V4m-4 4 4-4 4 4" />,
  // An arrow pointing down, for an order in its own direction, and one
  // pointing up, for an order reversed.
  "arrow-down": <path d="M12 4v16m-6-6 6 6 6-6" />,
  "arrow-up": <path d="M12 20V4m-6 6 6-6 6 6" />,
  // Two headings, each over its indented rows, for grouping.
  group: <path d="M3 4h9M7 8h14M7 11h14M3 15h9M7 19h14" />,
  // A chevron pointing down, for a group shown expanded; turned to point
  // along the line while it is collapsed.
  expand: <path d="m6 9 6 6 6-6" />,
  // Three dots in a row, for a message's options; filled, not stroked.
  options: (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </>
  ),
  // A closed envelope, for unread.
  unread: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  // An open envelope, for read.
  read: (
    <>
      <path d="M3 10 12 4l9 6v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="m3 10 9 6 9-6" />
    </>
  ),
  // A box under its lid, for archived.
  archive: (
    <>
      <rect x="2" y="4" width="20" height="5" rx="1" />
      <path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M10 13h4" />
    </>
  ),
  // A microphone on its stand, for dictation.
  microphone: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof shapes;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      {shapes[name]}
    </svg>
  );
}

// Mark is an icon that says something, such as that a thread is unread: the
// icon, what it says for assistive technology and as a tooltip, and, when
// given, a short text the eye reads beside it, such as how many are unread.
// An accented mark draws the eye.
export function Mark({
  icon,
  label,
  shown,
  accent = false,
}: {
  icon: IconName;
  label: string;
  shown?: string | number | undefined;
  accent?: boolean;
}) {
  return (
    <span className={accent ? "mark accent" : "mark"} title={label}>
      <Icon name={icon} />
      {shown === undefined ? (
        <span className="visually-hidden">{label}</span>
      ) : (
        <Spoken shown={String(shown)} spoken={label} />
      )}
    </span>
  );
}

// UnreadCount says whether a group holds threads with messages the operator
// has not read: the closed envelope with how many, or the open envelope.
export function UnreadCount({ unread }: { unread: number }) {
  return unread > 0 ? (
    <Mark icon="unread" label={`${unread} unread`} shown={unread} accent />
  ) : (
    <Mark icon="read" label="Read" />
  );
}
