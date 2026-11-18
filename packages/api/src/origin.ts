import { quoted } from "./text.ts";

// canonicalOrigin reads the HTTPS origin a person configures, the server's
// --origin and the bridge's AGENTION_URL alike, and returns its one canonical
// spelling: https, a domain name in lowercase ASCII, and a port only when it
// is not 443. Anything else is refused rather than corrected: another scheme,
// an IP address (browsers refuse passkeys for one), a host that is not a
// domain name, user information, a path other than "/", a query, a fragment,
// and an explicit default port, which a URL parser would silently drop. The
// server binds its passkeys, browser checks and agent tokens to this exact
// string, so both ends must spell it alike.
export function canonicalOrigin(value: string): string {
  const refuse = (why: string): never => {
    throw new Error(`${quoted(value)} is not an HTTPS origin: ${why}`);
  };
  // URL parsers strip surrounding whitespace and read a backslash as a slash;
  // refusing both up front keeps the check on the text the person wrote.
  const match = /^https:\/\/([^/?#\\\s\u0000-\u001f\u007f]*)\/?$/i.exec(value);
  if (match === null) {
    return refuse("it must be https:// and a host, with no path, query or fragment");
  }
  const authority = match[1] ?? "";
  if (authority.includes("@")) {
    return refuse("it must not carry user information");
  }
  const url = URL.parse(value);
  if (url === null || url.hostname === "") {
    return refuse("it must name a host");
  }
  // A URL parser writes every IPv4 address, in whatever form it was given, as
  // four decimal numbers, and an IPv6 address in brackets.
  if (url.hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    return refuse("it must be a domain name, not an IP address");
  }
  // A domain name, as the parser writes it after converting an
  // internationalized one to ASCII: labels of 1 to 63 letters, digits and
  // hyphens, and at most 253 characters in all.
  if (
    url.hostname.length > 253 ||
    !url.hostname.split(".").every((label) => /^[a-z0-9-]{1,63}$/.test(label))
  ) {
    return refuse(
      "its host must be a domain name: labels of up to 63 letters, digits and hyphens, " +
        "joined by single dots, at most 253 characters in all",
    );
  }
  // The authority ends in a port when its last colon follows the host.
  if (/:\d*$/.test(authority) && url.port === "") {
    return refuse("leave out the default port 443");
  }
  return url.origin;
}
