import { describe, expect, it } from "vitest";
import {
  declaredTypeOf,
  dispositionOf,
  fileName,
  fileNameKey,
  fileReadQuery,
  fileRef,
  servedTypeOf,
  servedTypes,
  typeOfName,
  uploadQuery,
} from "./files.ts";
import { threadFilesQuery } from "./threads.ts";

const astral = "\u{1F600}";
const ref = "AbCdEfGhIjKlMnOpQr_-09";

describe("fileName", () => {
  it.each([
    "report.pdf",
    "build log.txt",
    "...",
    ".env",
    "a..b",
    "Report (final, v2).docx",
    "照片.jpg",
    astral.repeat(200),
  ])("takes %j", (value) => {
    expect(fileName.safeParse(value).success).toBe(true);
  });

  it.each([
    ["an empty name", ""],
    ["one past the bound", "n".repeat(201)],
    [".", "."],
    ["..", ".."],
    ["a slash", "a/b"],
    ["a backslash", "a\\b"],
    ["a leading space", " a"],
    ["a trailing space", "a "],
    ["trailing no-break space", "a\u00a0"],
    ["a line feed", "a\nb"],
    ["a tab", "a\tb"],
    ["a bidirectional override", "a\u202eb"],
    ["a lone surrogate", `a${String.fromCharCode(0xd800)}`],
  ])("refuses %s", (_, value) => {
    expect(fileName.safeParse(value).success).toBe(false);
  });

  it("compares names after NFC normalization, case kept", () => {
    expect(fileNameKey(`e${String.fromCharCode(0x301)}.txt`)).toBe(fileNameKey("\u00e9.txt"));
    expect(fileNameKey("A.txt")).not.toBe(fileNameKey("a.txt"));
  });
});

describe("fileRef", () => {
  it("takes 22 characters of base64url", () => {
    expect(fileRef.safeParse(ref).success).toBe(true);
  });

  it.each([
    ["one short", ref.slice(1)],
    ["one long", `${ref}A`],
    ["padding", `${ref.slice(2)}==`],
    ["base64's own characters", `${ref.slice(2)}+/`],
  ])("refuses %s", (_, value) => {
    expect(fileRef.safeParse(value).success).toBe(false);
  });
});

describe("declaredTypeOf", () => {
  it.each([
    ["image/png", "image/png"],
    ["IMAGE/PNG", "image/png"],
    ["text/plain; charset=utf-8", "text/plain"],
    [" application/json ;x=1", "application/json"],
    ["image/svg+xml", "image/svg+xml"],
    ["image/jpg", "image/jpeg"],
    ["audio/x-wav", "audio/wav"],
    ["audio/wave", "audio/wav"],
    ["audio/x-m4a", "audio/mp4"],
    ["audio/mp3", "audio/mpeg"],
    ["audio/x-flac", "audio/flac"],
    [undefined, "application/octet-stream"],
    ["", "application/octet-stream"],
    ["image", "application/octet-stream"],
    ["image/", "application/octet-stream"],
    ["image/png/x", "application/octet-stream"],
    ["image/p ng", "application/octet-stream"],
    ["image/\u00e9", "application/octet-stream"],
    [`a/${"b".repeat(125)}`, `a/${"b".repeat(125)}`],
    [`a/${"b".repeat(126)}`, "application/octet-stream"],
  ])("reads %j as %s", (value, declared) => {
    expect(declaredTypeOf(value)).toBe(declared);
  });
});

describe("typeOfName", () => {
  it.each([
    ["photo.PNG", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.heif", "image/heic"],
    ["drawing.svg", "image/svg+xml"],
    ["paper.pdf", "application/pdf"],
    ["clip.webm", "video/webm"],
    ["clip.ogv", "video/ogg"],
    ["memo.m4a", "audio/mp4"],
    ["memo.ogg", "audio/ogg"],
    ["build.log", "text/plain"],
    ["main.rs", "text/plain"],
    ["page.html", "text/plain"],
    ["archive.tar.gz", "application/octet-stream"],
    ["Makefile", "application/octet-stream"],
    [".png", "application/octet-stream"],
    ["photo.", "application/octet-stream"],
    ["odd.constructor", "application/octet-stream"],
  ])("types %j as %s", (name, type) => {
    expect(typeOfName(name)).toBe(type);
  });
});

describe("servedTypeOf", () => {
  it.each([
    ["image/png", "image/png", "inline"],
    ["image/webp", "image/webp", "inline"],
    ["image/svg+xml", "image/svg+xml", "attachment"],
    ["application/pdf", "application/pdf", "inline"],
    ["video/mp4", "video/mp4", "inline"],
    ["audio/flac", "audio/flac", "inline"],
    ["text/plain", "text/plain; charset=utf-8", "inline"],
    ["text/html", "text/plain; charset=utf-8", "inline"],
    ["text/javascript", "text/plain; charset=utf-8", "inline"],
    ["text/css", "text/plain; charset=utf-8", "inline"],
    ["application/json", "text/plain; charset=utf-8", "inline"],
    ["application/x-ndjson", "text/plain; charset=utf-8", "inline"],
    ["application/xhtml+xml", "application/octet-stream", "attachment"],
    ["application/javascript", "application/octet-stream", "attachment"],
    ["image/heic", "application/octet-stream", "attachment"],
    ["image/avif", "application/octet-stream", "attachment"],
    ["application/zip", "application/octet-stream", "attachment"],
    ["", "application/octet-stream", "attachment"],
  ])("serves %j as %s, %s", (declared, served, disposition) => {
    expect(servedTypeOf(declared)).toBe(served);
    expect(dispositionOf(servedTypeOf(declared))).toBe(disposition);
  });

  it("serves whatever a client declares as one of the served types", () => {
    const pieces = ["text", "image", "application", "audio", "video", "x", "svg+xml", "html", ""];
    const extras = ["", ";charset=utf-8", " ", "/x", "\u0000", "\n"];
    for (const top of pieces) {
      for (const sub of pieces) {
        for (const extra of extras) {
          for (const value of [`${top}/${sub}${extra}`, `${top.toUpperCase()}/${sub}${extra}`]) {
            expect(servedTypes).toContain(servedTypeOf(declaredTypeOf(value)));
          }
        }
      }
    }
  });
});

describe("queries", () => {
  it("takes an upload's name and refuses a missing or invalid one", () => {
    expect(uploadQuery.parse({ name: "build log.txt" })).toEqual({ name: "build log.txt" });
    expect(uploadQuery.safeParse({}).success).toBe(false);
    expect(uploadQuery.safeParse({ name: "../key" }).success).toBe(false);
  });

  it("takes a file read with or without the file's reference", () => {
    expect(fileReadQuery.parse({})).toEqual({});
    expect(fileReadQuery.parse({ file: ref })).toEqual({ file: ref });
    expect(fileReadQuery.safeParse({ file: "nope" }).success).toBe(false);
  });

  it("pages a thread's files by cursor, a page at a time", () => {
    expect(threadFilesQuery.parse({})).toEqual({ limit: 50 });
    expect(threadFilesQuery.parse({ cursor: "c", limit: "100" })).toEqual({
      cursor: "c",
      limit: 100,
    });
    expect(threadFilesQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(threadFilesQuery.safeParse({ cursor: "" }).success).toBe(false);
  });
});
