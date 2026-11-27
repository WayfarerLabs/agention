import type { HttpBindings } from "@hono/node-server";
import type { Scope } from "@wayfarerlabs/agention-api";
import type { ApiSchema } from "@wayfarerlabs/agention-api/json-schemas";
import type { Context, Hono } from "hono";
import { refusedActivity } from "../audit/actions.ts";
import type { FailureRecorder } from "../audit/record.ts";
import { ApiError } from "../errors.ts";
import { holds, type Identity, scopeRefused } from "../identity.ts";
import type { Store } from "../store/index.ts";
import { parse, parseBody, parseQuery, type Schema } from "./input.ts";

// An operation is a route declared once, with its schemas, so that both the
// route and the API's documentation are built from the declaration: a mount
// builds its routes from a list of operations, and the documentation reads
// the same list.

// The variables every authenticated route reads: who is acting, as the mount's
// authentication established.
export interface IdentityEnv {
  Variables: { identity: Identity };
}

// The schema an operation declares: it reads the input or describes the
// answer, and is one of the API's schemas, which the documentation describes.
export type DescribedSchema<T> = Schema<T> & ApiSchema;

// A body or an answer that is a file's bytes as they are, rather than JSON,
// which the documentation describes as binary. The mount reads no such body
// and writes no such answer: the handler reads a body of bytes from the
// request, and answers an answer of bytes as a Response it built.
export interface BytesBody {
  bytes: "body";
  // What the request's bytes and headers are, for the documentation.
  description: string;
}

// An answer of bytes, which a request may ask for one range of, with Range,
// answered 206, or 416 when it lies outside them.
export interface BytesAnswer {
  bytes: "answer";
  // What the answer's bytes and headers are, for the documentation.
  description: string;
  // The types the bytes are answered as.
  types: readonly string[];
  readonly value?: Response;
}

// isBytes says whether a declared body or answer is bytes rather than a
// schema.
export function isBytes(
  declared: DescribedSchema<unknown> | BytesBody | BytesAnswer,
): declared is BytesBody | BytesAnswer {
  return "bytes" in declared;
}

// Declaration is what the documentation reads of a route: its name (unique
// on its mount), method, path relative to its mount, with :name for each path
// parameter, one-line summary, any longer description, such as a limit it
// keeps, the scope it requires, and its schemas, or,
// for a body or an answer that is a file's bytes, their description. The
// path parameters' schema names each parameter as the path does.
export interface Declaration {
  name: string;
  method: "GET" | "POST";
  path: string;
  summary: string;
  description?: string | undefined;
  scope?: Scope | undefined;
  params?: DescribedSchema<unknown>;
  query?: DescribedSchema<unknown>;
  body?: DescribedSchema<unknown> | BytesBody;
  response: DescribedSchema<unknown> | BytesAnswer;
}

// What an operation's handler runs with: the store, who is calling, and the
// input its schemas parsed. signal aborts when the client goes away or the
// server shuts down, for an operation that waits. request is the request
// itself, which only an operation whose body or answer is bytes reads, and
// log is where it writes a failure it carries on past. dropConnection ends
// the connection the request arrived on at once, for an answer of bytes that
// fails after it started, so its client sees the answer cut short rather
// than ended; it is undefined when the app answers in process, through
// app.request, with no connection. refused records a refusal of a known API
// key that such an answer meets once it has started, as a download's later
// chunk meets a key revoked since, which its client sees only as the answer
// cut short.
export interface OperationInput<P, Q, B> {
  store: Store;
  identity: Identity;
  params: P;
  query: Q;
  body: B;
  readonly signal: AbortSignal;
  request: Request;
  log: (message: string) => void;
  dropConnection: (() => void) | undefined;
  refused: (error: unknown) => void;
}

// Operation is a declaration with the handler that answers it.
export interface Operation extends Declaration {
  handler(input: OperationInput<unknown, unknown, unknown>): unknown;
}

interface Definition<P, Q, B, R> {
  name: string;
  method: "GET" | "POST";
  path: string;
  summary: string;
  description?: string;
  params?: DescribedSchema<P>;
  query?: DescribedSchema<Q>;
  body?: DescribedSchema<B> | BytesBody;
  // An answer of bytes gives R as its value's type, a Response, so the
  // compiler holds its handler to one as it holds a JSON handler to its
  // schema: value is never set, and only carries the type.
  response: DescribedSchema<R> | (BytesAnswer & { readonly value?: R });
  handler(input: OperationInput<P, Q, B>): NoInfer<R> | Promise<NoInfer<R>>;
}

// operation declares an operation, typing its handler by its schemas: it
// takes the input they parse and must answer the response schema's type, so
// the compiler holds each declared answer to the code. An operation declaring
// a scope keeps it in its type, so a list can require one.
export function operation<P, Q, B, R, S extends Scope | undefined = undefined>(
  definition: Definition<P, Q, B, R> & { scope?: S },
): Operation & { scope: S } {
  // The mount parses each input with the schema declared beside the handler,
  // so the handler always receives the types it was declared with.
  return definition as unknown as Operation & { scope: S };
}

export interface MountOptions<E extends IdentityEnv = IdentityEnv> {
  store: Store;
  // Aborts when the server shuts down, ending the operations that wait.
  shutdown: AbortSignal;
  // Where a failure an operation carries on past is written.
  log: (message: string) => void;
  // authenticate establishes who is calling, before anything else the route
  // does, or throws.
  authenticate: (c: Context<E>) => Identity | Promise<Identity>;
  // Where a refusal of a known API key is recorded.
  recordFailure: FailureRecorder;
}

// addOperations adds a route for each operation to a mount. Each
// authenticates first, then refuses an identity without the operation's scope
// as not_found, as if the operation did not exist, before reading any input;
// then it reads the path, the query and a JSON body through their schemas, in
// that order, and answers what the handler returns, as JSON unless the
// operation answers bytes. A GET route answers HEAD too, without a body. A
// refusal of a known API key after it authenticated, for a scope or as
// revoked or expired since, is recorded in the audit log, within the key's
// own budget, which authenticating spent, and answered as before.
export function addOperations<E extends IdentityEnv>(
  api: Hono<E>,
  operations: readonly Operation[],
  options: MountOptions<E>,
): void {
  for (const each of operations) {
    api.on(each.method, each.path, async (c) => {
      const identity = await options.authenticate(c);
      try {
        return await answer(c, each, identity, options);
      } catch (error) {
        recordRefusal(options.recordFailure, each, identity, error, true);
        throw error;
      }
    });
  }
}

// recordRefusal records a refusal of a known API key, for a scope or as
// revoked or expired since it authenticated, within the key's own budget,
// which authenticating spent. One met once the answer started was answered
// with no status of its own.
function recordRefusal(
  recordFailure: FailureRecorder,
  each: Operation,
  identity: Identity,
  error: unknown,
  answered: boolean,
): void {
  if (!(error instanceof ApiError) || error.refusal === undefined) {
    return;
  }
  const { code } = error.refusal;
  recordFailure(
    { kind: "identity", identity },
    code === "scope"
      ? {
          action: "authorizeScope",
          operation: each.name,
          activity: refusedActivity(each.name, identity.origin.method),
        }
      : answered
        ? { action: "authenticateApiKey", code }
        : { action: "authenticateApiKey", code, unanswered: true },
  );
}

// answer runs an operation for an authenticated identity: the scope, then
// the input, then the handler.
async function answer<E extends IdentityEnv>(
  c: Context<E>,
  each: Operation,
  identity: Identity,
  options: MountOptions<E>,
): Promise<Response> {
  const { store, shutdown, log } = options;
  if (each.scope !== undefined && !holds(identity, each.scope)) {
    throw scopeRefused(identity);
  }
  const params = each.params === undefined ? undefined : parse(each.params, c.req.param());
  const query = each.query === undefined ? undefined : parseQuery(c, each.query);
  const body =
    each.body === undefined || isBytes(each.body) ? undefined : await parseBody(c, each.body);
  // The adapter's bindings, which the app has only when the listener
  // serves it.
  const outgoing = (c.env as HttpBindings | undefined)?.outgoing;
  const result = await each.handler({
    store,
    identity,
    params,
    query,
    body,
    // Built only when read, since only the operations that wait need it.
    get signal() {
      return AbortSignal.any([c.req.raw.signal, shutdown]);
    },
    request: c.req.raw,
    log,
    dropConnection: outgoing === undefined ? undefined : () => outgoing.destroy(),
    refused: (error) => recordRefusal(options.recordFailure, each, identity, error, false),
  });
  return isBytes(each.response) ? (result as Response) : c.json(result);
}
