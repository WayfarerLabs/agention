import { describe, expect, it } from "vitest";
import { canonicalOrigin } from "./origin.ts";

describe("canonicalOrigin", () => {
  it.each([
    ["https://agention.example.ts.net", "https://agention.example.ts.net"],
    ["https://agention.example.ts.net/", "https://agention.example.ts.net"],
    ["HTTPS://Agention.Example.TS.net", "https://agention.example.ts.net"],
    ["https://localhost:8443", "https://localhost:8443"],
    ["https://agention.example.com:8443/", "https://agention.example.com:8443"],
    ["https://b\u00fccher.example", "https://xn--bcher-kva.example"],
    [`https://${"a".repeat(63)}.example`, `https://${"a".repeat(63)}.example`],
  ])("canonicalizes %s", (value, canonical) => {
    expect(canonicalOrigin(value)).toBe(canonical);
  });

  it.each([
    ["plain HTTP", "http://agention.example.ts.net"],
    ["no scheme", "agention.example.ts.net"],
    ["no host", "https://"],
    ["a path", "https://agention.example.ts.net/threads"],
    ["a query", "https://agention.example.ts.net?x=1"],
    ["an empty query", "https://agention.example.ts.net/?"],
    ["a fragment", "https://agention.example.ts.net#top"],
    ["user information", "https://me@agention.example.ts.net"],
    ["the default port", "https://agention.example.ts.net:443"],
    ["the default port with a leading zero", "https://agention.example.ts.net:0443"],
    ["an IPv4 address", "https://127.0.0.1:8443"],
    ["an IPv4 address in another form", "https://0x7f.1"],
    ["an IPv6 address", "https://[::1]:8443"],
    ["surrounding whitespace", " https://agention.example.ts.net"],
    ["trailing whitespace", "https://agention.example.ts.net "],
    ["a backslash", "https://agention.example.ts.net\\"],
    ["an out-of-range port", "https://agention.example.ts.net:70000"],
    ["a host of dots", "https://.."],
    ["a host of one dot", "https://."],
    ["an empty label", "https://agention..example"],
    ["a trailing dot", "https://agention.example."],
    ["encoded dots", "https://%2e%2e"],
    ["a wildcard", "https://*"],
    ["an underscore", "https://agention_server.example"],
    ["a label longer than 63 characters", `https://${"a".repeat(64)}.example`],
    ["a host longer than 253 characters", `https://${"abcdefghi.".repeat(25)}example`],
  ])("refuses %s", (_, value) => {
    expect(() => canonicalOrigin(value)).toThrow();
  });

  it("quotes at most the first 100 characters of a value it refuses", () => {
    const value = `http://${"a".repeat(10_000)}.example`;
    expect(() => canonicalOrigin(value)).toThrow(`"http://${"a".repeat(93)}\u2026" is not`);
  });
});
