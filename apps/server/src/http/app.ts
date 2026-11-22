import {
  type ErrorBody,
  maxFileBytes,
  oversizedBodyStatus,
  statusByErrorCode,
  unsizedBodyStatus,
} from "@wayfarerlabs/agention-api";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiError } from "../errors.ts";
import type { Store, VoiceEnvironment } from "../store/index.ts";
import { openAiCompatible, type TranscriptionProvider } from "../transcription/provider.ts";
import { agentApi } from "./agent-api.ts";
import { stateAgentApiVersion } from "./agent-api-version.ts";
import { diagramFramePath, serveDiagramFrame } from "./diagram-frame.ts";
import { declaredOwn } from "./own-headers.ts";
import { defaultRates, RateBudgets, RateLimitedError, type Rates } from "./rates.ts";
import { freeBytes as fileSystemFreeBytes, isUploadRequest } from "./uploads.ts";
import { webApi } from "./web-api.ts";
import { serveWebUi } from "./web-ui.ts";

// Every request body is bounded, on every route. 2 MiB holds the largest write
// the schemas accept, about 1.9 MB with every field at its bound, ten asks and
// ten answers among them, and every character sent as an escaped surrogate
// pair. An upload's body is the file, up to maxFileBytes.
export const maxBodyBytes = 2 * 1024 * 1024;

// The content security policy of every response but the diagram frame's and
// files': the UI loads only its own scripts, styles, images and media, talks
// only to its own origin, and cannot be framed. Message text is rendered
// inert, and this backs that up. The UI frames only the diagram frame, and
// shows the images it makes from the frame's answers as blob: URLs.
export function contentSecurityPolicy(origin: string): string {
  return (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; " +
    `media-src 'self'; frame-src ${origin}${diagramFramePath}; connect-src 'self'; ` +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

// securityHeaderValues are the security headers every response carries, by
// name in lower case, with their values: those the app's middleware sets,
// and those the listener's own answers carry.
export function securityHeaderValues(origin: string): ReadonlyMap<string, string> {
  return new Map([
    ["content-security-policy", contentSecurityPolicy(origin)],
    ["strict-transport-security", "max-age=31536000"],
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "no-referrer"],
    ["cache-control", "no-store"],
  ]);
}

// securityHeaders sets the security headers on every response after its
// route has run. A route keeps a value of its own only for the headers it
// declared its own with ownHeaders; every other value is replaced.
export function securityHeaders(origin: string): MiddlewareHandler {
  const headers = securityHeaderValues(origin);
  return async (c, next) => {
    await next();
    for (const [header, value] of headers) {
      if (!(declaredOwn(c, header) && c.res.headers.has(header))) {
        c.res.headers.set(header, value);
      }
    }
  };
}

export interface AppOptions {
  store: Store;
  // The canonical origin people and agents reach the server at.
  origin: string;
  // The server's name, which the web UI shows as its title and a new passkey
  // carries as its relying party's name.
  name: string;
  // The directory holding the web UI's build; without one, a placeholder page
  // is served instead.
  webRoot: string | undefined;
  rates?: Rates;
  // Aborting it ends the long polls, for shutdown.
  shutdown?: AbortSignal;
  // Where internal errors are written; their details never reach the client.
  log?: (message: string) => void;
  // The voice settings the server's environment supplies.
  voiceEnvironment?: VoiceEnvironment;
  // The transcription provider's client; the OpenAI-compatible one unless
  // given another.
  transcription?: TranscriptionProvider;
  // How many bytes are free where the database lives, by default as the file
  // system says.
  freeBytes?: (directory: string) => Promise<number>;
}

const notFoundBody: ErrorBody = { error: { code: "not_found", message: "not found" } };

function invalidBody(message: string): ErrorBody {
  return { error: { code: "invalid_input", message } };
}

// createApp builds the server's one Hono application: the agent API at
// /api/agent, the web API at /api/web, the diagram frame at /diagram-frame,
// and the web UI on every other path.
export function createApp(options: AppOptions): Hono {
  const { store, origin, name } = options;
  const host = new URL(origin).host;
  const budgets = new RateBudgets(options.rates ?? defaultRates, store.clock);
  const shutdown = options.shutdown ?? new AbortController().signal;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const freeBytes = options.freeBytes ?? fileSystemFreeBytes;
  const app = new Hono();

  app.use(securityHeaders(origin));

  // Every answer on the agent mount states the agent API version the server
  // speaks, those of the checks before the mount included, so a bridge can
  // tell an answer from this server from one an older server gave.
  app.use("/api/agent/*", stateAgentApiVersion);

  // The server answers only for its origin's host, so a page on another name
  // that resolves to this server cannot reach it. No forwarded header is read.
  app.use(async (c, next) => {
    if (c.req.header("host")?.toLowerCase() !== host) {
      throw new ApiError("invalid_input", `this server answers only for ${host}`);
    }
    await next();
  });

  // A body must declare its length, so its size is known before anything is
  // read and before authentication runs.
  app.use("/api/*", async (c, next) => {
    if (c.req.header("transfer-encoding") !== undefined) {
      return c.json(invalidBody("send the body with a Content-Length"), unsizedBodyStatus);
    }
    return next();
  });
  // An upload's body is a file, and every other body a request of the API;
  // each has its own bound, chosen from the request's raw path as the
  // listener chooses its deadlines. With a Content-Length, the bound compares
  // the header alone and reads nothing.
  const fileLimit = bodyLimit({
    maxSize: maxFileBytes,
    onError: (c) =>
      c.json(
        invalidBody(`the file is larger than ${maxFileBytes / 1024 ** 2} MiB`),
        oversizedBodyStatus,
      ),
  });
  const requestLimit = bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) =>
      c.json(
        invalidBody(`the request body is larger than ${maxBodyBytes} bytes`),
        oversizedBodyStatus,
      ),
  });
  app.use("/api/*", (c, next) => {
    const { pathname } = new URL(c.req.url);
    return (isUploadRequest(c.req.method, pathname) ? fileLimit : requestLimit)(c, next);
  });

  app.route("/api/agent", agentApi({ store, origin, budgets, shutdown, log, freeBytes }));
  app.route(
    "/api/web",
    webApi({
      store,
      origin,
      name,
      budgets,
      voiceEnvironment: options.voiceEnvironment ?? {},
      transcription: options.transcription ?? openAiCompatible(),
      log,
      freeBytes,
    }),
  );
  app.all("/api", (c) => c.json(notFoundBody, 404));
  app.all("/api/*", (c) => c.json(notFoundBody, 404));
  serveDiagramFrame(app, options.webRoot, origin);
  serveWebUi(app, options.webRoot, name);
  app.notFound((c) => c.json(notFoundBody, 404));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      if (error instanceof RateLimitedError) {
        c.header("Retry-After", String(error.retryAfter));
      }
      return c.json(error.toBody(), statusByErrorCode[error.code]);
    }
    log(`internal error on ${c.req.method} ${c.req.path}: ${error.stack ?? String(error)}`);
    const body: ErrorBody = { error: { code: "internal", message: "internal error" } };
    return c.json(body, 500);
  });
  return app;
}
