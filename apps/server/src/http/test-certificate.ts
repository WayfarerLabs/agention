// A self-signed TLS certificate generated at test time, so no key is ever
// committed. Node can parse certificates but not make them, so this writes the
// few DER structures a P-256 certificate for one host name and 127.0.0.1
// needs.
import { generateKeyPairSync, sign } from "node:crypto";

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length;
  if (length < 0x80) {
    return Buffer.concat([Buffer.from([tag, length]), content]);
  }
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) {
    bytes.unshift(rest & 0xff);
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), content]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, item: Buffer) => tlv(0xa0 + n, item);

function integer(value: Buffer): Buffer {
  return tlv(0x02, (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) {
      chunk.unshift(0x80 | (value & 0x7f));
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return tlv(0x17, Buffer.from(`${text}Z`));
}

const ecdsaWithSha256 = sequence(oid("1.2.840.10045.4.3.2"));

export interface TestCertificate {
  cert: string;
  key: string;
}

// testCertificate makes a certificate for hostName, valid for an hour.
export function testCertificate(hostName = "localhost"): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const now = Date.now();
  const name = sequence(set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(hostName)))));
  const subjectAltName = sequence(
    tlv(0x82, Buffer.from(hostName)),
    tlv(0x87, Buffer.from([127, 0, 0, 1])),
  );
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(Buffer.from([1])),
    ecdsaWithSha256,
    name,
    sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 3_600_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, sequence(sequence(oid("2.5.29.17"), tlv(0x04, subjectAltName)))),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = sequence(
    tbs,
    ecdsaWithSha256,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const base64 = der.toString("base64").replace(/.{64}/g, "$&\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}
