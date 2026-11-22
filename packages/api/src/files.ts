import { z } from "zod";
import { sequence } from "./bounds.ts";
import { singleLineText } from "./text.ts";
import { timestamp } from "./time.ts";

// Files a message carries. A writer uploads a file first, which answers with
// its reference, and a message then names that upload to attach it, for
// good. Until a message names it, an upload is pending: its writer's own, in
// the session it was uploaded under, for pendingLifetime after it completes.
// A message carries each file under a name unique within it, and a
// replacement carries a file of the message it replaces only by keeping it.

// The largest file, in bytes.
export const maxFileBytes = 100 * 1024 * 1024;

// The most files one message carries.
export const maxAttachments = 10;

// The most pending uploads, and pending bytes by their declared sizes, one
// writer holds at once, those still arriving included.
export const maxPendingFiles = 20;
export const maxPendingBytes = 1024 * 1024 * 1024;

// How long a completed upload waits for a message to name it, in
// milliseconds.
export const pendingLifetime = 24 * 60 * 60 * 1000;

// A size in bytes, or a total of them.
const byteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// A file's name, which fits one path segment and one header: a single line
// of 1 to 200 code points without white space at either end, that is neither
// . nor .. and holds no / or \. It is stored as written. Two names are the
// same name when they are equal after NFC normalization, case kept.
export const fileName = singleLineText({ min: 1, max: 200 })
  .refine((value) => !/[/\\]/.test(value), "must not contain / or \\")
  .refine((value) => value !== "." && value !== "..", "must not be . or ..")
  .refine((value) => !/^\s|\s$/u.test(value), "must not start or end with white space")
  .meta({ minLength: 1, maxLength: 200 });

// fileNameKey gives a file name in the form two names are compared in: two
// names are the same name when their keys are equal.
export function fileNameKey(name: string): string {
  return name.normalize("NFC");
}

// An upload's reference, which messages name it by: 16 random bytes in
// base64url without padding.
export const fileRef = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/, "must be 22 of A-Z, a-z, 0-9, '_' and '-'");

// Types.

// What an upload declares itself as, read from a Content-Type: its essence,
// lowercased, when that is token/token of at most 127 characters, under its
// standard name where it has a common alias; otherwise, or without one,
// application/octet-stream. It is the type a file is stored and listed with.
const typeToken = "[!#$%&'*+.^_`|~0-9a-z-]+";
const typeEssence = new RegExp(`^${typeToken}/${typeToken}$`);
const typeAliases: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/mp3": "audio/mpeg",
  "audio/x-flac": "audio/flac",
};
const unknownFileType = "application/octet-stream";

export function declaredTypeOf(contentType: string | undefined): string {
  const essence = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence.length > 127 || !typeEssence.test(essence)) {
    return unknownFileType;
  }
  return typeAliases[essence] ?? essence;
}

// The type of a file by its name's extension, for a client that has none to
// declare. It never reads the file.
const textExtensions = [
  "txt",
  "md",
  "markdown",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "sh",
  "bash",
  "py",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "lua",
  "sql",
  "diff",
  "patch",
  "html",
  "htm",
  "css",
  "scss",
];
const typesByExtension: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heic",
  pdf: "application/pdf",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  ...Object.fromEntries(textExtensions.map((extension) => [extension, "text/plain"])),
};

export function typeOfName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(typesByExtension, extension)
    ? typesByExtension[extension]!
    : unknownFileType;
}

// The types a file is served as, whatever it declared. None is a script or
// style type.
const textServedType = "text/plain; charset=utf-8";
export const servedTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
  "audio/wav",
  "audio/flac",
  textServedType,
  unknownFileType,
] as const;
export type ServedType = (typeof servedTypes)[number];
export const servedType = z.enum(servedTypes);

// Declared types served as text, beside every text/ type.
const textTypes = new Set([
  "application/json",
  "application/xml",
  "application/x-ndjson",
  "application/yaml",
  "application/toml",
]);

// servedTypeOf maps a declared type, as declaredTypeOf gives it, onto the
// served types: an allowlisted image, document or media type as itself, text
// as plain UTF-8 text, and anything else, HEIC and HTML's lookalikes
// included, as bytes to download.
export function servedTypeOf(declared: string): ServedType {
  if ((servedTypes as readonly string[]).includes(declared)) {
    return declared as ServedType;
  }
  if (declared.startsWith("text/") || textTypes.has(declared)) {
    return textServedType;
  }
  return unknownFileType;
}

// The Content-Disposition a served type is answered with: inline, or
// attachment, which a browser downloads when the file is opened on its own.
// SVG is served as itself, so an image element draws it, but never opens as
// a document.
export type Disposition = "inline" | "attachment";

export function dispositionOf(served: ServedType): Disposition {
  return served === "image/svg+xml" || served === unknownFileType ? "attachment" : "inline";
}

// Requests.

// An upload's query: the name the file is attached under unless a message
// names another. The body is the file's bytes, its Content-Type the declared
// type.
export const uploadQuery = z.object({ name: fileName });
export type UploadQuery = z.infer<typeof uploadQuery>;

// One file a message carries: one of the writer's own pending uploads, under
// its own name or the one given, or a file the message it replaces carries,
// by its name there.
export const attachment = z
  .object({
    upload: fileRef
      .optional()
      .describe(
        "The reference an upload of yours answered with, in this session and not yet attached " +
          "to a message.",
      ),
    name: fileName
      .optional()
      .describe(
        "With upload: the name to attach the file under, by default the one it was uploaded " +
          "under.",
      ),
    keep: fileName
      .optional()
      .describe(
        "On a replacement: a file of the message it replaces, by its name there, which this " +
          "message carries again.",
      ),
  })
  .superRefine((value, context) => {
    if (value.upload === undefined && value.keep === undefined) {
      context.addIssue({ code: "custom", path: [], message: "needs an upload or a file to keep" });
    } else if (value.upload !== undefined && value.keep !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["keep"],
        message: "names an upload or a file to keep, not both",
      });
    } else if (value.keep !== undefined && value.name !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "names only an upload: a kept file keeps its name",
      });
    }
  });
export type Attachment = z.infer<typeof attachment>;

// A message's files, in the order given: omitted rather than empty. No upload
// is named twice, and no two names given, kept or named, are the same name.
// A name an upload brings with it is the store's to compare, since only it
// knows the name.
export const attachmentList = z
  .array(attachment)
  .min(1)
  .max(maxAttachments)
  .superRefine((items, context) => {
    const uploads = new Set<string>();
    const names = new Set<string>();
    items.forEach((each, index) => {
      if (each.upload !== undefined) {
        if (uploads.has(each.upload)) {
          context.addIssue({
            code: "custom",
            path: [index, "upload"],
            message: "names an upload this message already attaches",
          });
        }
        uploads.add(each.upload);
      }
      const given = each.name ?? each.keep;
      if (given !== undefined) {
        const key = fileNameKey(given);
        if (names.has(key)) {
          context.addIssue({
            code: "custom",
            path: [index, each.name === undefined ? "keep" : "name"],
            message: "another file of this message has this name",
          });
        }
        names.add(key);
      }
    });
  })
  .describe(
    `Up to ${maxAttachments} files this message carries, in order, each under a name unique ` +
      "within it. Upload a file first, then name its upload here; a replacement carries a file " +
      "of the message it replaces only by keeping it.",
  );

// A file read's query: the reference of the file the message carries under
// the name in the path, which the web UI gives so a URL always names the
// same bytes.
export const fileReadQuery = z.object({ file: fileRef.optional() });
export type FileReadQuery = z.infer<typeof fileReadQuery>;

// Responses.

// What an upload produced: its reference, its name, size and declared type,
// the type it is served as, and when it expires unless a message names it.
export const uploadResult = z.object({
  upload: fileRef,
  name: fileName,
  size: byteCount,
  type: z.string(),
  served_type: servedType,
  expires_at: timestamp,
});
export type UploadResult = z.infer<typeof uploadResult>;

// A file as a message carries it: its name there, its reference, size and
// declared type, from which a reader derives the served type with
// servedTypeOf. A kept file has the same reference in both messages. missing
// says its contents are gone.
export const attachmentRead = z.object({
  name: z.string(),
  file: fileRef,
  size: byteCount,
  type: z.string(),
  missing: z.literal(true).optional(),
});
export type AttachmentRead = z.infer<typeof attachmentRead>;

// How many distinct files something holds, each counted once however many
// messages carry it, and their bytes.
export const fileTotals = z.object({ count: sequence, bytes: byteCount });
export type FileTotals = z.infer<typeof fileTotals>;
