// A notice one page leaves for the next, said once there: the thread page
// that goes back to the list after sending says what it sent. It lives only
// in this page's memory, so a reload or a later visit never repeats it.

let pending: string | undefined;

export function leaveNotice(text: string): void {
  pending = text;
}

// takeNotice gives the notice left, once.
export function takeNotice(): string | undefined {
  const text = pending;
  pending = undefined;
  return text;
}
