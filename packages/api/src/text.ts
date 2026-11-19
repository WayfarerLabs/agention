import { z } from "zod";

// Text bounds count Unicode code points, as JSON Schema's minLength and
// maxLength do, so a character outside the Basic Multilingual Plane counts once
// even though JavaScript stores it as two UTF-16 code units.
export function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) {
    length++;
  }
  return length;
}

// What a single line refuses: control characters (line feeds and the other C0
// and C1 controls), the Unicode line and paragraph separators, and the
// invisible characters that make text read differently from what it holds:
// bidirectional embeddings, overrides and isolates, the zero-width space, the
// word joiner and the byte order mark. Other format characters stay, because
// real text needs them: joiners in emoji sequences and in scripts such as
// Persian, and soft hyphens.
const notOnOneLine = /[\p{Cc}\p{Zl}\p{Zp}\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/u;

export interface TextBounds {
  min: number;
  max: number;
}

// Text with a minimum length is required text, which also needs a character
// other than white space.
function boundedText({ min, max }: TextBounds) {
  return z
    .string()
    .refine((value) => value.isWellFormed(), "must be valid Unicode text")
    .refine((value) => !value.includes("\u0000"), "must not contain NUL characters")
    .refine((value) => codePointLength(value) >= min, `must be at least ${min} characters`)
    .refine((value) => codePointLength(value) <= max, `must be at most ${max} characters`)
    .refine(
      (value) => min === 0 || /\S/u.test(value),
      "must contain a character other than white space",
    );
}

// Text that may span lines, such as Markdown or fallback text. Every text field
// must be encodable as UTF-8 (no unpaired surrogates) and free of NUL. The
// metadata advertises the bounds in generated JSON Schema; it is attached last
// because each zod method returns a new schema without it.
export function multilineText(bounds: TextBounds) {
  return boundedText(bounds).meta({ minLength: bounds.min, maxLength: bounds.max });
}

// Plain text on one line: it also refuses line breaks, control characters
// and format characters.
export function singleLineText(bounds: TextBounds) {
  return boundedText(bounds)
    .refine(
      (value) => !notOnOneLine.test(value),
      "must be one line without control or format characters",
    )
    .meta({ minLength: bounds.min, maxLength: bounds.max });
}

// quoted writes a value someone configured into a message, as JSON, keeping
// at most its first 100 characters, so a message quoting it stays short
// whatever the value holds.
export function quoted(value: string): string {
  const characters = [...value];
  return JSON.stringify(
    characters.length <= 100 ? value : `${characters.slice(0, 100).join("")}\u2026`,
  );
}
