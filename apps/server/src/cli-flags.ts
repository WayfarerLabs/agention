// The command line's own mistakes, and the readers of options several
// commands share.

// A command-line mistake, reported as a usage error.
export class UsageError extends Error {}

// wholeNumberFlag reads an option that is a whole number within bounds.
export function wholeNumberFlag(
  flag: string,
  value: string | undefined,
  bounds: { min: number; max: number },
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN;
  if (!(number >= bounds.min && number <= bounds.max)) {
    throw new UsageError(`${flag} must be a whole number from ${bounds.min} to ${bounds.max}`);
  }
  return number;
}
