import { type BaseUrlCheck, normalizeBaseUrl } from "@wayfarerlabs/agention-server-api";
import { BlockList, isIP } from "node:net";

// The base URL rule: where a transcription provider may be. It reads a base
// URL into its stored form, then judges the host that form holds, an IP
// address in whatever spelling it was given, as the WHATWG URL parser
// normalizes it. https reaches any host but those never reached; plain http
// only localhost and IP addresses on the operator's own network, since the
// key and the audio cross it unencrypted. Never reached, over either scheme:
// link-local addresses, the cloud metadata addresses outside them, the
// unspecified address, multicast and the NAT64 local-use prefix. A host name
// other than localhost is not resolved here: over https, the provider's
// certificate is what binds it.

// Addresses no base URL may name. An IPv4-mapped IPv6 address is judged as
// the IPv4 address it maps, and one in the NAT64 well-known prefix is
// refused as the IPv4 address it embeds would be (see embeddedIpv4).
const never = new BlockList();
never.addSubnet("0.0.0.0", 8, "ipv4");
never.addSubnet("169.254.0.0", 16, "ipv4");
never.addSubnet("224.0.0.0", 4, "ipv4");
never.addAddress("::", "ipv6");
never.addSubnet("fe80::", 10, "ipv6");
never.addSubnet("ff00::", 8, "ipv6");
// Cloud metadata services outside the link-local ranges: Alibaba Cloud's,
// AWS's over IPv6 and Google Cloud's over IPv6.
never.addAddress("100.100.100.200", "ipv4");
never.addAddress("fd00:ec2::254", "ipv6");
never.addAddress("fd20:ce::254", "ipv6");

// The operator's own network, where plain http is allowed: loopback, the
// private ranges, the shared range a tailnet uses, and unique local IPv6
// addresses.
const own = new BlockList();
own.addSubnet("127.0.0.0", 8, "ipv4");
own.addSubnet("10.0.0.0", 8, "ipv4");
own.addSubnet("172.16.0.0", 12, "ipv4");
own.addSubnet("192.168.0.0", 16, "ipv4");
own.addSubnet("100.64.0.0", 10, "ipv4");
own.addAddress("::1", "ipv6");
own.addSubnet("fc00::", 7, "ipv6");

// The NAT64 well-known prefix, 64:ff9b::/96, whose last 32 bits are the
// IPv4 address a translator reaches.
const nat64 = new BlockList();
nat64.addSubnet("64:ff9b::", 96, "ipv6");

// The NAT64 local-use prefix, 64:ff9b:1::/48 (RFC 8215), within which a
// network chooses its own translator's prefix, from /48 to /96. Where the IPv4
// address sits depends on that choice, so an address here cannot be judged by
// the address it embeds, and is refused outright.
const localNat64 = new BlockList();
localNat64.addSubnet("64:ff9b:1::", 48, "ipv6");

// embeddedIpv4 gives the IPv4 address an IPv6 address in the NAT64 prefix
// embeds, or undefined for any other address.
function embeddedIpv4(host: string): string | undefined {
  if (isIP(host) !== 6 || !nat64.check(host, "ipv6")) {
    return undefined;
  }
  // The URL parser writes IPv6 in hexadecimal groups, "::" for the longest
  // run of zeros, never with a dotted IPv4 tail.
  const [head = "", tail = ""] = host.split("::");
  const groupsOf = (part: string) => (part === "" ? [] : part.split(":"));
  const before = groupsOf(head);
  const after = groupsOf(tail);
  const zeros = Math.max(8 - before.length - after.length, 0);
  const all = [...before, ...Array<string>(zeros).fill("0"), ...after];
  const low = (Number.parseInt(all[6] ?? "0", 16) << 16) | Number.parseInt(all[7] ?? "0", 16);
  return [24, 16, 8, 0].map((shift) => (low >>> shift) & 0xff).join(".");
}

// checkBaseUrl applies the whole rule. Its reasons never quote the value.
export function checkBaseUrl(value: string): BaseUrlCheck {
  const normalized = normalizeBaseUrl(value);
  if ("problem" in normalized) {
    return normalized;
  }
  const url = new URL(normalized.url);
  // The parser writes an IPv6 address in brackets.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const version = isIP(host);
  const family = version === 4 ? "ipv4" : version === 6 ? "ipv6" : undefined;
  if (version === 6 && localNat64.check(host, "ipv6")) {
    return {
      problem:
        "must not be a local-use NAT64 address, since the IPv4 address it reaches depends on " +
        "your network's translator; give a host name over https, or the IPv4 address itself, instead",
    };
  }
  // An address in the NAT64 prefix is refused as the IPv4 address it
  // embeds would be, but is never the operator's own network: a translator
  // carries it across networks they may not control.
  const embedded = embeddedIpv4(host);
  if (
    (family !== undefined && never.check(host, family)) ||
    (embedded !== undefined && never.check(embedded, "ipv4"))
  ) {
    return { problem: "must not be a link-local, metadata, unspecified or multicast address" };
  }
  const ownNetwork = family === undefined ? url.hostname === "localhost" : own.check(host, family);
  if (url.protocol === "http:" && !ownNetwork) {
    return {
      problem:
        "must use https: unless its host is localhost or an IP address on your own network " +
        "(loopback, private, tailnet or unique local)",
    };
  }
  return normalized;
}
