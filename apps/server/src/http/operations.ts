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

// Declaration is what the documentation reads of a route: its name (unique
// on its mount), method, path relative to its mount, with :name for each path
// parameter, one-line summary, the scope it requires, and its schemas. The
// path parameters' schema names each parameter as the path does.
export interface Declaration {
  name: string;
  method: "GET" | "POST";
  path: string;
  summary: string;
  scope?: Scope | undefined;
  params?: DescribedSchema<unknown>;
  query?: DescribedSchema<unknown>;
  body?: DescribedSchema<unknown>;
  response: DescribedSchema<unknown>;
}

// What an operation's handler runs with: the store, who is calling, and the
// input its schemas parsed. signal aborts when the client goes away or the
// server shuts down, for an operation that waits.
export interface OperationInput<P, Q, B> {
  store: Store;
  identity: Identity;
  params: P;
  query: Q;
  body: B;
  readonly signal: AbortSignal;
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
  params?: DescribedSchema<P>;
  query?: DescribedSchema<Q>;
  body?: DescribedSchema<B>;
  response: DescribedSchema<R>;
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
  // authenticate establishes who is calling, before anything else the route
  // does, or throws.
  authenticate: (c: Context<IdentityEnv>) => Identity | Promise<Identity>;
}

// addOperations adds a route for each operation to a mount. Each
// authenticates first, then refuses an identity without the operation's scope
// as not_found, as if the operation did not exist, before reading any input;
// then it reads the path, the query and the body through their schemas, in
// that order, and answers what the handler returns.
export function addOperations(
  api: Hono<IdentityEnv>,
  operations: readonly Operation[],
  options: MountOptions,
): void {
  const { store, shutdown, authenticate } = options;
  for (const each of operations) {
    api.on(each.method, each.path, async (c) => {
      const identity = await authenticate(c);
      if (each.scope !== undefined && !holds(identity, each.scope)) {
        throw notFound();
      }
      const params = each.params === undefined ? undefined : parse(each.params, c.req.param());
      const query = each.query === undefined ? undefined : parseQuery(c, each.query);
      const body = each.body === undefined ? undefined : await parseBody(c, each.body);
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
      });
      return c.json(result);
    });
  }
}
