import { describe, expect, it } from "vitest";
import { formatAddress, parseConnectAddress } from "./connect-address.ts";

describe("AGENTION_CONNECT", () => {
  it.each([
    ["127.0.0.1:8443", { host: "127.0.0.1", port: 8443 }],
    ["[::1]:8443", { host: "::1", port: 8443 }],
    ["localhost:8443", { host: "localhost", port: 8443 }],
    ["127.0.0.1:65535", { host: "127.0.0.1", port: 65535 }],
  ])("reads %s, and writes it back as it was given", (value, address) => {
    expect(parseConnectAddress(value)).toEqual(address);
    expect(formatAddress(address)).toBe(value);
  });

  it.each([
    "",
    "127.0.0.1",
    ":8443",
    "127.0.0.1:0",
    "127.0.0.1:00080",
    "127.0.0.1:65536",
    "::1:8443",
    "[localhost]:8443",
    "https://localhost:8443",
    "agent@localhost:8443",
    " localhost:8443",
  ])("refuses %j", (value) => {
    expect(() => parseConnectAddress(value)).toThrow();
  });
});
