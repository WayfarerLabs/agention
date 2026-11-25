import { createContext, type RefObject } from "react";

// Whether the list's bar owes the rows focus: from a mark key pressed on a
// row until its action is done, when the bar returns focus to that row, or
// the row in its place should the action take it out of the list, unless the
// operator has moved focus meanwhile. A row that goes while it holds focus
// leaves focus to the bar while it does, rather than passing it on itself,
// since the list may load afresh, and the row go, before the action is done.
export const RowFocusOwed = createContext<RefObject<boolean> | undefined>(undefined);
