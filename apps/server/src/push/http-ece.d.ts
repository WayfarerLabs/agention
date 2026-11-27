// The part of http_ece, Martin Thomson's implementation of RFC 8188 and RFC
// 8291, that the encryption tests use to decrypt what the server sends. It is
// a development dependency only, never bundled: an independent implementation
// that checks ours.
declare module "http_ece" {
  import type { ECDH } from "node:crypto";

  interface DecryptParams {
    version: "aes128gcm";
    privateKey: ECDH;
    authSecret: Uint8Array;
  }

  const ece: { decrypt(body: Uint8Array, params: DecryptParams): Buffer };
  export default ece;
}
