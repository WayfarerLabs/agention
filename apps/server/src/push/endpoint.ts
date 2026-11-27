// The endpoint rule: where the server sends a notification. Only to the
// browsers' own push services, by host name, over HTTPS on the default port,
// so a subscription can never point the server at the operator's network, a
// link-local or metadata address, or anything else. The name is never
// resolved here: HTTPS and the push service's certificate bind it. The rule
// runs when a device registers its subscription and again before each send,
// so a row stored before a change to the list is refused too.

// The push services' hosts: those exactly, and any host under those with a
// leading dot, matched at a dot boundary. A new browser's push service needs
// its host here.
const pushHosts = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.apple.com"];
const pushDomains = [".push.apple.com", ".notify.windows.com"];

export const maxEndpointLength = 2048;

// endpointProblem says why the server will not send to an endpoint, or
// nothing when it will: an absolute https: URL, at most 2048 characters as
// given and in the canonical form the server stores, on the default port,
// with no user information, whose host is a known push service's. The WHATWG
// parser lowercases the host and writes :443 as no port for https:, so a port
// of any other number is refused; a trailing dot, a look-alike, and an IP
// literal match no host.
export function endpointProblem(endpoint: string): string | undefined {
  if (endpoint.length > maxEndpointLength) {
    return `must be at most ${maxEndpointLength} characters`;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "must be an absolute https: URL";
  }
  if (url.href.length > maxEndpointLength) {
    return `must be at most ${maxEndpointLength} characters`;
  }
  if (url.protocol !== "https:") {
    return "must be an https: URL";
  }
  if (url.port !== "") {
    return "must use the default port";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not carry a user name or password";
  }
  const host = url.hostname;
  const known =
    pushHosts.includes(host) ||
    pushDomains.some((domain) => host.length > domain.length && host.endsWith(domain));
  return known ? undefined : "is not a push service this server sends to";
}
