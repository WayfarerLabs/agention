import {
  type ErrorBody,
  oversizedBodyStatus,
  statusByErrorCode,
  unsizedBodyStatus,
} from "@wayfarerlabs/agention-api";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiError } from "../errors.ts";
import type { Store } from "../store/index.ts";
import { agentApi } from "./agent-api.ts";
import { stateAgentApiVersion } from "./agent-api-version.ts";
import { diagramFramePath, type OwnHeaders, serveDiagramFrame } from "./diagram-frame.ts";
import { defaultRates, RateBudgets, RateLimitedError, type Rates } from "./rates.ts";
import { webApi } from "./web-api.ts";
import { serveWebUi } from "./web-ui.ts";

// Every request body is bounded, on every route. 2 MiB holds the largest write
// the schemas accept, about 1.9 MB with every field at its bound, ten asks and
// ten answers among them, and every character sent as an escaped surrogate
// pair.
export const maxBodyBytes = 2 * 1024 * 1024;

// The content security policy of every response but the diagram frame's: the
// UI loads only its own scripts, styles and images, talks only to its own
// origin, and cannot be framed. Message text is rendered inert, and this
// backs that up. The UI frames only the diagram frame, and shows the images
// it makes from the frame's answers as blob: URLs.
export function contentSecurityPolicy(origin: string): string {
  return (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; " +
    `frame-src ${origin}${diagramFramePath}; connect-src 'self'; base-uri 'none'; ` +
    "form-action 'self'; frame-ancestors 'none'"
  );
}

// securityHeaders sets the security headers on every response, by name in
// lower case, after its route has run. A route keeps a value of its own only
// for the headers own names for its path, which only the diagram frame's
// routes have; every other route's value is replaced.
export function securityHeaders(origin: string, own: () => OwnHeaders): MiddlewareHandler {
  const headers = new Map([
    ["content-security-policy", contentSecurityPolicy(origin)],
    ["strict-transport-security", "max-age=31536000"],
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "no-referrer"],
    ["cache-control", "no-store"],
  ]);
  return async (c, next) => {
    await next();
    const kept = own().get(c.req.path) ?? [];
    for (const [header, value] of headers) {
      if (!(kept.includes(header) && c.res.headers.has(header))) {
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
  const app = new Hono();

  // Set below, once the diagram frame's routes are known.
  let ownHeaders: OwnHeaders = new Map();
  app.use(securityHeaders(origin, () => ownHeaders));

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
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) =>
        c.json(
          invalidBody(`the request body is larger than ${maxBodyBytes} bytes`),
          oversizedBodyStatus,
        ),
    }),
  );

  app.route("/api/agent", agentApi({ store, origin, budgets, shutdown, log }));
  app.route("/api/web", webApi({ store, origin, name, budgets }));
  app.all("/api", (c) => c.json(notFoundBody, 404));
  app.all("/api/*", (c) => c.json(notFoundBody, 404));
  ownHeaders = serveDiagramFrame(app, options.webRoot, origin);
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
