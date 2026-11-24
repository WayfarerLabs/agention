import { createContext } from "react";

// The thread list as it stands beside a thread, side by side, where it stays
// mounted while threads open and close beside it; undefined while the list
// is on screen alone. open is the address of the thread open beside it, and
// left, once none is, the address of the thread last open, so going back to
// the list lands on that thread's row.
export interface Beside {
  open: string | undefined;
  left: string | undefined;
}

export const ListBeside = createContext<Beside | undefined>(undefined);
