import type { HttpBindings } from "@hono/node-server";
import type { Scope } from "@wayfarerlabs/agention-api";
import type { ApiSchema } from "@wayfarerlabs/agention-api/json-schemas";
import type { Context, Hono } from "hono";
import { notFound } from "../errors.ts";
import { holds, type Identity } from "../identity.ts";
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
// app.request, with no connection.
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

export interface MountOptions {
  store: Store;
  // Aborts when the server shuts down, ending the operations that wait.
  shutdown: AbortSignal;
  // Where a failure an operation carries on past is written.
  log: (message: string) => void;
  // authenticate establishes who is calling, before anything else the route
  // does, or throws.
  authenticate: (c: Context<IdentityEnv>) => Identity | Promise<Identity>;
}

// addOperations adds a route for each operation to a mount. Each
// authenticates first, then refuses an identity without the operation's scope
// as not_found, as if the operation did not exist, before reading any input;
// then it reads the path, the query and a JSON body through their schemas, in
// that order, and answers what the handler returns, as JSON unless the
// operation answers bytes. A GET route answers HEAD too, without a body.
export function addOperations(
  api: Hono<IdentityEnv>,
  operations: readonly Operation[],
  options: MountOptions,
): void {
  const { store, shutdown, log, authenticate } = options;
  for (const each of operations) {
    api.on(each.method, each.path, async (c) => {
      const identity = await authenticate(c);
      if (each.scope !== undefined && !holds(identity, each.scope)) {
        throw notFound();
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
      });
      return isBytes(each.response) ? (result as Response) : c.json(result);
    });
  }
}
