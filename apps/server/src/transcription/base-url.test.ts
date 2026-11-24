import { describe, expect, it } from "vitest";
import { checkBaseUrl } from "./base-url.ts";

describe("the base URL rule", () => {
  it.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1"],
    ["https://api.openai.com/v1/", "https://api.openai.com/v1"],
    ["HTTPS://API.OpenAI.com/v1//", "https://api.openai.com/v1"],
    ["https://api.openai.com", "https://api.openai.com"],
    ["https://transcribe.example:8443/openai/v1", "https://transcribe.example:8443/openai/v1"],
    ["https://transcribe.example:443/v1", "https://transcribe.example/v1"],
    ["http://localhost:8000/v1", "http://localhost:8000/v1"],
    ["http://127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1"],
    ["http://0x7f.1/v1", "http://127.0.0.1/v1"],
    ["http://10.1.2.3/v1", "http://10.1.2.3/v1"],
    ["http://172.16.0.1/v1", "http://172.16.0.1/v1"],
    ["http://172.31.255.255/v1", "http://172.31.255.255/v1"],
    ["http://192.168.1.20:9000", "http://192.168.1.20:9000"],
    ["http://100.64.0.1/v1", "http://100.64.0.1/v1"],
    ["http://100.127.255.254/v1", "http://100.127.255.254/v1"],
    ["http://[::1]:8000/v1", "http://[::1]:8000/v1"],
    ["http://[fd7a:115c:a1e0::1]/v1", "http://[fd7a:115c:a1e0::1]/v1"],
    ["http://100.100.100.201/v1", "http://100.100.100.201/v1"],
    ["http://[fd00:ec2::253]/v1", "http://[fd00:ec2::253]/v1"],
    ["http://[::ffff:192.168.1.2]/v1", "http://[::ffff:c0a8:102]/v1"],
    ["https://[2001:db8::1]/v1", "https://[2001:db8::1]/v1"],
    ["https://8.8.8.8/v1", "https://8.8.8.8/v1"],
    ["https://[64:ff9b::808:808]/v1", "https://[64:ff9b::808:808]/v1"],
    ["https://[64:ff9b::a00:1]/v1", "https://[64:ff9b::a00:1]/v1"],
  ])("keeps %s as %s", (value, stored) => {
    expect(checkBaseUrl(value)).toEqual({ url: stored });
  });

  it.each([
    ["a relative URL", "/v1"],
    ["another scheme", "ftp://transcribe.example/v1"],
    ["a file URL", "file:///v1"],
    ["user information", "https://me:secret@transcribe.example/v1"],
    ["a user name", "https://me@transcribe.example/v1"],
    ["a query", "https://transcribe.example/v1?key=1"],
    ["an empty query", "https://transcribe.example/v1?"],
    ["a fragment", "https://transcribe.example/v1#x"],
    ["an empty fragment", "https://transcribe.example/v1#"],
    ["surrounding whitespace", " https://transcribe.example/v1"],
    ["a control character", "https://transcribe.example/v1\u0007"],
    ["a name over plain http", "http://transcribe.example/v1"],
    ["a public address over plain http", "http://8.8.8.8/v1"],
    ["an address just outside 172.16.0.0/12", "http://172.32.0.1/v1"],
    ["an address just outside the tailnet range", "http://100.128.0.1/v1"],
    ["a public IPv6 address over plain http", "http://[2001:db8::1]/v1"],
    ["a link-local address", "https://169.254.169.254/latest"],
    ["a link-local address over plain http", "http://169.254.169.254/latest"],
    ["a link-local address in another form", "https://0xa9fea9fe/latest"],
    ["an IPv4-mapped link-local address", "https://[::ffff:169.254.169.254]/latest"],
    ["an IPv4-mapped link-local address in hexadecimal", "https://[::ffff:a9fe:a9fe]/latest"],
    ["an IPv6 link-local address", "https://[fe80::1]/v1"],
    ["the unspecified address", "https://0.0.0.0/v1"],
    ["the IPv6 unspecified address", "https://[::]/v1"],
    ["a multicast address", "https://224.0.0.1/v1"],
    ["an IPv6 multicast address", "https://[ff02::1]/v1"],
    ["an IPv4-mapped public address over plain http", "http://[::ffff:8.8.8.8]/v1"],
    ["Alibaba Cloud's metadata address", "https://100.100.100.200/latest"],
    ["Alibaba Cloud's metadata address over plain http", "http://100.100.100.200/latest"],
    ["AWS's IPv6 metadata address", "https://[fd00:ec2::254]/latest"],
    ["AWS's IPv6 metadata address over plain http", "http://[fd00:ec2::254]/latest"],
    ["Google Cloud's IPv6 metadata address", "https://[fd20:ce::254]/latest"],
    ["Google Cloud's IPv6 metadata address over plain http", "http://[fd20:ce::254]/latest"],
    ["a NAT64 link-local address", "https://[64:ff9b::a9fe:a9fe]/v1"],
    ["a NAT64 link-local address written dotted", "https://[64:ff9b::169.254.169.254]/v1"],
    ["a NAT64 metadata address", "https://[64:ff9b::6464:64c8]/latest"],
    ["the NAT64 unspecified address", "https://[64:ff9b::]/v1"],
    ["a NAT64 public address over plain http", "http://[64:ff9b::808:808]/v1"],
    ["a NAT64 private address over plain http", "http://[64:ff9b::a00:1]/v1"],
    ["a local-use NAT64 address", "https://[64:ff9b:1::808:808]/v1"],
    ["a local-use NAT64 address embedding at /48", "https://[64:ff9b:1:a9fe:a9:fe00::]/latest"],
    [
      "a local-use NAT64 address at the prefix's end",
      "https://[64:ff9b:1:ffff:ffff:ffff:ffff:ffff]/v1",
    ],
    ["a local-use NAT64 address over plain http", "http://[64:ff9b:1::a00:1]/v1"],
    ["a URL past 2,048 characters", `https://transcribe.example/${"a".repeat(2048)}`],
  ])("refuses %s", (_, value) => {
    expect(checkBaseUrl(value)).toHaveProperty("problem");
  });

  it("never quotes the value it refuses", () => {
    const value = "http://secret-host.example/v1";
    const checked = checkBaseUrl(value);
    expect("problem" in checked && checked.problem.includes("secret-host")).toBe(false);
  });
});
