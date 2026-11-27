import type { HttpBindings } from "@hono/node-server";
import type { Context } from "hono";
import { routePath } from "hono/route";
import { isIP } from "node:net";
import type { RequestOrigin } from "../identity.ts";

// The longest user agent an origin keeps, in UTF-16 code units.
export const maxUserAgent = 256;

// The longest address an origin keeps, which OCSF 1.9.0's ip_t allows.
const maxAddress = 40;

// peerAddress normalizes a connection's peer address for the audit log: an
// IPv4-mapped IPv6 address, which a dual-stack socket reports, as its IPv4
// form, and anything that is not an address or is too long to keep as none.
export function peerAddress(address: string | undefined): string | undefined {
  if (address === undefined) {
    return undefined;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  return isIP(ip) === 0 || ip.length > maxAddress ? undefined : ip;
}

// boundedUserAgent cuts a user agent to maxUserAgent code units, never
// splitting a surrogate pair.
export function boundedUserAgent(userAgent: string | undefined): string | undefined {
  if (userAgent === undefined || userAgent.length <= maxUserAgent) {
    return userAgent;
  }
  const last = userAgent.charCodeAt(maxUserAgent - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return userAgent.slice(0, splitsPair ? maxUserAgent - 1 : maxUserAgent);
}

// requestOrigin reads where a request came from, for the identity a mount
// builds: the connection's peer, which a request answered in process has
// none of, the user agent, the method, the routed path, and the pattern of
// the route handling it, which is what a failure records in place of the
// path the client chose. It runs in the route's handler, or middleware
// declared with the route, where the pattern is the route's own, with the
// mount and the server's origin. No forwarded header is read.
export function requestOrigin(
  c: Context,
  service: RequestOrigin["service"],
  serverOrigin: string,
): RequestOrigin {
  const incoming = (c.env as HttpBindings | undefined)?.incoming;
  const method = c.req.method;
  return {
    ip: peerAddress(incoming?.socket.remoteAddress),
    userAgent: boundedUserAgent(c.req.header("user-agent")),
    method: method === "GET" || method === "HEAD" ? method : "POST",
    path: c.req.path,
    route: routePath(c),
    service,
    serverOrigin,
  };
}
