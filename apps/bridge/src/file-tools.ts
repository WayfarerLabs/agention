import {
  type AttachmentRead,
  fileName,
  fileNameKey,
  maxFileBytes,
  message,
  sequence,
  type ServedType,
  servedType,
  threadNumber,
  typeOfName,
  type UploadResult,
} from "@wayfarerlabs/agention-api";
import {
  createPrivateFile,
  ensurePrivateDirectory,
  PrivateFileError,
} from "@wayfarerlabs/agention-private-files";
import { randomBytes } from "node:crypto";
import {
  constants,
  createWriteStream,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Downloaded } from "./agent-api.ts";
import { ApiFailure, BridgeError, detailOf, settingProblem } from "./errors.ts";
import { keyDirectory } from "./key-file.ts";
import { type Connected, type DefineTool, type InSession, WithContent } from "./tools.ts";

// The tools that move files between this machine and the server: file_upload
// sends one up for a message to attach, and file_get fetches one a message
// carries into the bridge's own directory.

// The largest image file_get also answers with as an image block, whose
// base64 then stays under 5 MB, the strictest limit an agent host was found
// to set on one.
export const maxImageBlockBytes = 3.5 * 1024 * 1024;

// How long a fetched file is kept: fetched files are a cache, which every
// file_get prunes.
export const fetchedFileLifetime = 7 * 24 * 60 * 60 * 1000;

// The directory fetched files are written to, below the home directory and
// outside the key directory, which every server and session shares: a file's
// reference is random, so no two files' names collide.
export function fetchedFilesDirectory(home: string): string {
  return path.join(home, ".cache", "agention", "files");
}

// The extension a fetched file is named with, by the type it was served as,
// never from the name its sender gave it.
const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "text/plain; charset=utf-8": "txt",
};

// The raster images an answer may carry as an image block, each with the
// signature its leading bytes start with, which it must: the one place the
// bridge reads a file's content.
const imageSignatures: Readonly<Record<string, (head: Buffer) => boolean>> = {
  "image/png": (head) =>
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  "image/gif": (head) => ["GIF87a", "GIF89a"].includes(head.toString("latin1", 0, 6)),
  "image/webp": (head) =>
    head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP",
};

const absolutePath = z
  .string()
  .refine((value) => path.isAbsolute(value), "must be an absolute path")
  .refine((value) => Buffer.byteLength(value) <= 4096, "must be at most 4,096 bytes");

const fileUploadInput = z.object({
  path: absolutePath.describe("The file's absolute path on this machine."),
  name: fileName
    .optional()
    .describe("The name to attach the file under; by default the last segment of its path."),
});

const fileGetInput = z.object({
  thread: threadNumber.describe("The thread's number in this session."),
  seq: sequence.min(1).describe("The sequence of the message that carries the file."),
  name: fileName.describe("The file's name in that message, as its attachments list it."),
});

const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MiB`;

// registerFileTools defines the file tools, with the helper the other tools
// are defined with.
export function registerFileTools(
  tool: DefineTool,
  connected: () => Connected,
  inSession: (signal: AbortSignal) => Promise<InSession>,
): void {
  tool(
    "file_upload",
    "Upload a file from this machine, by its absolute path, for a message to attach. Answers " +
      "with its upload reference: name it in attachments of message_send or thread_create, as " +
      "{upload}, before expires_at, and the message carries it for good. The name, by default " +
      `the file's own, is the one it is attached under. Up to ${megabytes(maxFileBytes)}; ` +
      "only a regular file, and none of the bridge's own key directory. A large file on a slow " +
      "link can outlast your host's limit on one tool call. Each upload is one request of this " +
      "session's rate budget, so a burst of many files can be refused as rate_limited: wait the " +
      "seconds its message names, then call again.",
    fileUploadInput,
    async (input, signal) => {
      const { home } = connected();
      const name = input.name ?? nameOf(input.path);
      const file = await openForUpload(input.path);
      try {
        const { size } = await checkForUpload(file, input.path, home);
        const { api, key, sessionPath } = await inSession(signal);
        const result = (await api.upload(key, {
          path: `${sessionPath}/uploads`,
          query: { name },
          file,
          size,
          type: typeOfName(name),
          signal,
        })) as UploadResult;
        return {
          ...result,
          message:
            "Name it in attachments of message_send or thread_create as {upload} before " +
            "expires_at.",
        };
      } finally {
        await file.close();
      }
    },
  );

  tool(
    "file_get",
    "Fetch a file that a message of one of this session's threads carries, the operator's or " +
      "yours, by the thread, the message's seq and the file's name as its attachments list it, " +
      "into a directory of the bridge's own on this machine. Answers with the file's path, its " +
      "name, size, type and the type it is served as; a PNG, JPEG, GIF or WebP image of up to " +
      `${megabytes(maxImageBlockBytes)} comes as an image as well. A fetched file is removed ` +
      "a week after it was fetched, so copy it elsewhere to keep it.",
    fileGetInput,
    async (input, signal) => {
      const { home } = connected();
      const { api, key, sessionPath } = await inSession(signal);
      const thread = `${sessionPath}/threads/${input.thread}`;
      // The message's list of files gives the file's reference, which names
      // what is fetched and the file it is written to.
      const page = await api.request(key, {
        method: "GET",
        path: thread,
        query: { after: input.seq - 1, limit: 1 },
        signal,
      });
      const carried = findCarried(page, input, api.origin);
      const directory = fetchedDirectory(home);
      prune(directory, Date.now());
      const part = path.join(directory, `.${randomBytes(8).toString("hex")}.part`);
      const into = createWriteStream(part, { fd: createdPart(part) });
      // The file goes into place only once it is whole; until then, and if it
      // never is, the partial file is all there is, and a failure removes it.
      let downloaded: Downloaded;
      let served: ServedType | undefined;
      let fetched: string;
      try {
        downloaded = await api.download(
          key,
          {
            path: `${thread}/messages/${input.seq}/files/${encodeURIComponent(carried.name)}`,
            query: { file: carried.file },
            signal,
          },
          into,
        );
        served = servedType.safeParse(downloaded.servedType).data;
        fetched = path.join(
          directory,
          `${carried.file}.${(served && extensions[served]) ?? "bin"}`,
        );
        renameSync(part, fetched);
      } catch (error) {
        into.destroy();
        rmSync(part, { force: true });
        if (error instanceof ApiFailure || error instanceof BridgeError) {
          throw error;
        }
        throw new BridgeError(
          `Check that this user can write files in ${directory}, and that its disk has room ` +
            `(${detailOf(error)}).`,
        );
      }
      const answer = {
        path: fetched,
        name: carried.name,
        size: downloaded.size,
        type: carried.type,
        served_type: downloaded.servedType,
      };
      const signature = served === undefined ? undefined : imageSignatures[served];
      if (served === undefined || signature === undefined) {
        return answer;
      }
      if (downloaded.size > maxImageBlockBytes) {
        return {
          ...answer,
          message: "This image is too large to show here; read the file at path.",
        };
      }
      const bytes = readFileSync(fetched);
      if (!signature(bytes)) {
        return answer;
      }
      return new WithContent(answer, [
        { type: "image", data: bytes.toString("base64"), mimeType: served },
      ]);
    },
  );
}

// nameOf is the name a file is attached under by default: its path's last
// segment, which must be a name a file can have.
function nameOf(filePath: string): string {
  const name = path.basename(filePath);
  if (!fileName.safeParse(name).success) {
    throw ApiFailure.of(
      "invalid_input",
      "the file's own name is not one a file can be attached under; give name",
      "name",
    );
  }
  return name;
}

// openForUpload opens a file to read, without waiting, so a FIFO in its place
// cannot hold the call up, and without making a terminal in its place the
// bridge's controlling terminal.
async function openForUpload(filePath: string): Promise<FileHandle> {
  try {
    return await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    throw unopened(error);
  }
}

// unopened refuses a path the bridge cannot open or resolve.
function unopened(error: unknown): ApiFailure {
  const code = detailOf(error);
  const why =
    code === "ENOENT"
      ? "names no file on this machine"
      : code === "EACCES"
        ? "names a file this user cannot read"
        : `names a file the bridge cannot open (${code})`;
  return ApiFailure.of("invalid_input", why, "path");
}

// checkForUpload refuses what the bridge never uploads, from the open file:
// anything but a regular file, one of the bridge's own key directory, by its
// real path, so a key named through a symlink is refused too, and a file over
// the size limit. The key directory check keeps an agent from handing a
// credential to the server by mistake; it is no boundary against the agent,
// which runs as this user and could read the key itself. So it resolves the
// path again rather than the open file, and a symlink swapped between the
// two is left alone: only something running as this user could swap it.
async function checkForUpload(
  file: FileHandle,
  filePath: string,
  home: string,
): Promise<{ size: number }> {
  const stats = await file.stat();
  if (!stats.isFile()) {
    throw ApiFailure.of(
      "invalid_input",
      "names something other than a regular file, and only a file's contents are uploaded",
      "path",
    );
  }
  let real: string;
  try {
    real = realpathSync(filePath);
  } catch (error) {
    throw unopened(error);
  }
  const keys = realPathOrUndefined(keyDirectory(home));
  if (keys !== undefined && isWithin(real, keys)) {
    throw ApiFailure.of(
      "invalid_input",
      "names a file in the bridge's own key directory, ~/.config/agention, whose files are " +
        "never uploaded",
      "path",
    );
  }
  if (stats.size > maxFileBytes) {
    throw ApiFailure.of(
      "invalid_input",
      `names a file larger than ${megabytes(maxFileBytes)}, the most a file may be`,
      "path",
    );
  }
  return { size: stats.size };
}

function realPathOrUndefined(at: string): string | undefined {
  try {
    return realpathSync(at);
  } catch {
    return undefined;
  }
}

function isWithin(at: string, directory: string): boolean {
  return (
    at === directory ||
    at.startsWith(directory.endsWith(path.sep) ? directory : directory + path.sep)
  );
}

// What file_get reads of a page of a thread: its messages' sequences and
// files, in the shared schemas, so a file's reference, which names the file
// it is written to, is one and never a path.
const carriedPage = z.object({
  messages: z.array(message.pick({ seq: true, attachments: true })),
});

// findCarried finds the file a message carries under a name, compared as
// names are, in a page of the thread that starts at the message.
function findCarried(
  page: unknown,
  input: { seq: number; name: string },
  origin: string,
): AttachmentRead {
  const parsed = carriedPage.safeParse(page);
  if (!parsed.success) {
    throw settingProblem(
      `The server at ${origin} answered the thread's read with something other than ` +
        "Agention's JSON",
      "set AGENTION_URL to the Agention server's origin",
    );
  }
  const first = parsed.data.messages[0];
  if (first?.seq !== input.seq) {
    throw ApiFailure.of("not_found", "not found", "seq");
  }
  const carried = first.attachments?.find(
    (each) => fileNameKey(each.name) === fileNameKey(input.name),
  );
  if (carried === undefined) {
    throw ApiFailure.of("not_found", "not found", "name");
  }
  return carried;
}

// fetchedDirectory makes the directory fetched files go to, under the
// private-file rule, and returns its real path.
function fetchedDirectory(home: string): string {
  const directory = fetchedFilesDirectory(home);
  try {
    return ensurePrivateDirectory(directory);
  } catch (error) {
    const detail =
      error instanceof PrivateFileError ? `${error.reason} at ${error.path}` : detailOf(error);
    throw new BridgeError(
      `The bridge keeps the files it fetches in ${directory}, which must be a directory that ` +
        "belongs to this user with mode 700, below directories only this user or root can " +
        `change (${detail}). Fix that, or remove it for the bridge to make it again.`,
    );
  }
}

// prune removes what was fetched, or left half fetched, more than
// fetchedFileLifetime ago, by when it was last written. Another bridge may be
// pruning the same directory, so an entry already gone is no failure.
function prune(directory: string, now: number): void {
  for (const entry of readdirSync(directory)) {
    const at = path.join(directory, entry);
    try {
      const stats = lstatSync(at);
      if (!stats.isDirectory() && now - stats.mtimeMs > fetchedFileLifetime) {
        rmSync(at, { force: true });
      }
    } catch {
      // Gone already, or not this user's to remove; the next call tries again.
    }
  }
}

// createdPart creates the file a download is written to, until it is
// complete and renamed into place.
function createdPart(part: string): number {
  let fd: number | undefined;
  try {
    fd = createPrivateFile(part);
  } catch (error) {
    throw new BridgeError(
      `Check that this user can write files in ${path.dirname(part)} (${detailOf(error)}).`,
    );
  }
  if (fd === undefined) {
    throw new BridgeError(`Remove ${part}, which is in the way of a fetched file, and try again.`);
  }
  return fd;
}
