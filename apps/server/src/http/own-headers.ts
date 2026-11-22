import type { Context } from "hono";

// The security headers middleware sets every security header on every
// response, replacing what a route set, except the headers a route declares
// as its own for its response: the diagram frame's policy and framing, its
// script's caching, and a file's sandbox policy and caching. A route declares
// them as it sets them, so the rule follows the route whatever its path.

// The headers each request's route declared its own, by name in lower case.
const declared = new WeakMap<Request, Set<string>>();

// ownHeaders declares that the route answering a request sets the named
// security headers for itself, so the middleware keeps the route's values.
export function ownHeaders(request: Request, names: readonly string[]): void {
  const own = declared.get(request) ?? new Set<string>();
  for (const name of names) {
    own.add(name.toLowerCase());
  }
  declared.set(request, own);
}

// declaredOwn says whether the route answering c declared a header its own.
export function declaredOwn(c: Context, name: string): boolean {
  return declared.get(c.req.raw)?.has(name) ?? false;
}
