import { createCipheriv, createECDH, type ECDH, hkdfSync, randomBytes } from "node:crypto";

// Web Push message encryption (RFC 8291): the aes128gcm content coding of
// RFC 8188, keyed by an ECDH agreement with the device's P-256 key and its
// authentication secret, in one record. Every message is padded to one size,
// so its length says nothing of what it holds.

// The record's plaintext is always this long: the data, the delimiter 0x02,
// then zero octets. The largest payload the server sends fits with room to
// spare, and every body is then 86 + 1024 + 16 = 1126 bytes, well within the
// smallest limit a push service sets (Mozilla's 2744 through its bridge).
export const paddedLength = 1024;
export const maxDataLength = paddedLength - 1;

// The record size the header states: the largest a record may be, the same
// for every message, not its length.
const recordSize = 4096;

// The keys a device's subscription encrypts to: its public key, an
// uncompressed P-256 point of 65 octets, and its 16-octet secret.
export interface DeviceKeys {
  p256dh: Uint8Array;
  auth: Uint8Array;
}

const derive = (key: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) =>
  Buffer.from(hkdfSync("sha256", key, salt, info, length));

// encryptRecord encrypts one record's plaintext, as given, for a device under
// the message's own key pair and salt, and answers the body: the header (the
// salt, the record size, and the message's public key as the key id) and the
// ciphertext with its tag. It is the steps of RFC 8291 section 3 with fixed
// inputs, which the RFC's worked example checks.
export function encryptRecord(
  record: Uint8Array,
  device: DeviceKeys,
  message: { ecdh: ECDH; salt: Uint8Array },
): Buffer {
  const asPublic = message.ecdh.getPublicKey();
  const ecdhSecret = message.ecdh.computeSecret(device.p256dh);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), device.p256dh, asPublic]);
  const ikm = derive(ecdhSecret, device.auth, keyInfo, 32);
  const cek = derive(ikm, message.salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = derive(ikm, message.salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(recordSize);
  return Buffer.concat([message.salt, size, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

// encryptPush pads data to the one record size and encrypts it for a device
// under a new key pair and salt. Data that would not fit is refused rather
// than sent in a longer record, whose length would say more than the others.
export function encryptPush(data: Uint8Array, device: DeviceKeys): Buffer {
  if (data.length > maxDataLength) {
    throw new Error(`a push message holds at most ${maxDataLength} bytes`);
  }
  const record = Buffer.alloc(paddedLength);
  record.set(data);
  record[data.length] = 0x02;
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return encryptRecord(record, device, { ecdh, salt: randomBytes(16) });
}
