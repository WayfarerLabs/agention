import { quoted } from "@wayfarerlabs/agention-api";
import { isIP } from "node:net";

// Where the bridge opens its connections to the server: a host name or IP
// address, IPv6 without its brackets, and a port.
export interface ConnectAddress {
  host: string;
  port: number;
}

// parseConnectAddress reads AGENTION_CONNECT: a host and a port, such as
// 127.0.0.1:8443, [::1]:8443 or localhost:8443. The host is an IPv6 address
// in brackets, or anything without a colon, slash, at sign, white space or
// bracket, so a URL is refused: the scheme, the server's name and everything
// after the connection opens come from AGENTION_URL. The certificate is
// checked against the origin's host wherever the bridge connects, so the host
// needs no more checking here; one that names nothing fails to connect. The
// port is decimal, without leading zeros, so it reads as it is written.
export function parseConnectAddress(value: string): ConnectAddress {
  const match = /^(?:\[([^\]]*)\]|([^:/@\s[\]]+)):([1-9]\d{0,4})$/.exec(value);
  const bracketed = match?.[1];
  const host = bracketed ?? match?.[2];
  const port = Number(match?.[3]);
  if (host === undefined || (bracketed !== undefined && isIP(host) !== 6) || port > 65535) {
    throw new Error(
      `${quoted(value)} is not a host and port, such as 127.0.0.1:8443, [::1]:8443 or ` +
        "localhost:8443",
    );
  }
  return { host, port };
}

// formatAddress writes an address as AGENTION_CONNECT spells it.
export function formatAddress(address: ConnectAddress): string {
  return isIP(address.host) === 6
    ? `[${address.host}]:${address.port}`
    : `${address.host}:${address.port}`;
}
