import { z } from "zod";
import { threadNumber } from "./bounds.ts";
import { codePointLength, singleLineText } from "./text.ts";

export const maxUrlLength = 2048;

const whitespaceOrControl = /[\s\u0000-\u001f\u007f-\u009f]/;

// isLinkableUrl is the one rule for a URL Agention shows as a link: absolute
// https, with a host, without user information, at most 2,048 characters, and
// written plainly (valid Unicode, without whitespace or control characters,
// which URL parsers would silently strip or encode). Anything else is shown as
// text, never followed.
export function isLinkableUrl(value: string): boolean {
  if (
    !value.isWellFormed() ||
    codePointLength(value) > maxUrlLength ||
    whitespaceOrControl.test(value)
  ) {
    return false;
  }
  if (!/^https:\/\//i.test(value)) {
    return false;
  }
  // new URL rather than URL.parse, which some browsers the web UI supports
  // lack.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === ""
  );
}

// A URL Agention shows as a link: one isLinkableUrl accepts.
export const linkableUrl = z
  .string()
  .refine(isLinkableUrl, "must be an absolute https URL with a host and no user information")
  .meta({ format: "uri", maxLength: maxUrlLength });

// A reference to something outside Agention, such as a pull request or a CI
// run, or to another thread of the same session: a label plus at least one of
// an identifier, a URL and a thread number. References are displayed, never
// fetched; a thread's number shows as a link to it.
export const reference = z
  .object({
    label: singleLineText({ min: 1, max: 100 }),
    identifier: singleLineText({ min: 1, max: 200 }).optional(),
    url: linkableUrl.optional(),
    thread: threadNumber.optional().describe("A thread of the same session, by its number."),
  })
  .refine(
    (value) =>
      value.identifier !== undefined || value.url !== undefined || value.thread !== undefined,
    { message: "needs an identifier, a URL or a thread", path: ["identifier"] },
  );

export type Reference = z.infer<typeof reference>;

// A message's references: omitted rather than empty.
export const referenceList = z.array(reference).min(1).max(20);
