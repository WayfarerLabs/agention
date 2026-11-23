// A notice one page leaves for the next, said once there: the thread page
// that goes back to the list after sending says what it sent, and one that
// goes on to the next thread after sending leaves it for that thread's page.
// It lives only in this page's memory, so a reload or a later visit never
// repeats it.

// Where a notice is said: the thread list, or the next thread's page.
export type NoticePlace = "list" | "thread";

const pending: Partial<Record<NoticePlace, string>> = {};

export function leaveNotice(text: string, place: NoticePlace = "list"): void {
  pending[place] = text;
}

// takeNotice gives the notice left for a place, once.
export function takeNotice(place: NoticePlace = "list"): string | undefined {
  const text = pending[place];
  delete pending[place];
  return text;
}
