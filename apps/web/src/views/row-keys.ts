// Moving through a list's rows by the keyboard, as the thread list's and the
// sessions' rows do. The current row is the row holding focus, on any
// control within it, so moving from row to row moves focus, which a screen
// reader follows, and the focus ring shows it. With focus on no row, side by
// side, the row of what is open beside the list is current, so moving starts
// from it and opens nothing; with none current, moving goes to the first row
// there is to move to. Opening acts only on the row holding focus, never on
// the open one's from what is open beside the list, which would only take
// focus from where the operator is.

// focusedRow gives the place, among the rows' controls given in order, of
// the row holding focus, or -1: row is the selector of a row.
function focusedRow(controls: HTMLElement[], row: string): number {
  const holding = document.activeElement?.closest(row) ?? null;
  return holding === null ? -1 : controls.findIndex((control) => holding.contains(control));
}

// currentRow gives the place of the current row: the row holding focus, or
// else the open one's, or -1.
export function currentRow(controls: HTMLElement[], row: string): number {
  const at = focusedRow(controls, row);
  return at !== -1
    ? at
    : controls.findIndex((control) => control.getAttribute("aria-current") === "page");
}

// stepRow moves focus by one row, stopping at either end.
export function stepRow(controls: HTMLElement[], row: string, by: 1 | -1): void {
  const at = currentRow(controls, row);
  (at === -1 ? controls[0] : controls[at + by])?.focus();
}

// openRow follows the control of the row holding focus, as a click on it
// does, and does nothing while no row holds focus.
export function openRow(controls: HTMLElement[], row: string): void {
  controls[focusedRow(controls, row)]?.click();
}
