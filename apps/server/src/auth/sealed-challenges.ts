import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "../database/database.ts";

// A passkey ceremony runs in two requests, and its challenge must survive
// between them without the server storing anything a flood could fill. Begin
// seals the challenge, its kind and its expiry, with whatever else finish
// needs, under the instance's challenge key into the browser's cookie; finish
// accepts only a seal the key verifies, of the expected kind and unexpired.
// A ceremony that succeeds records its challenge as used until it expires, so
// it cannot be replayed.

export type CeremonyKind = "signin" | "link" | "add";

// The time a person has to answer their authenticator.
export const challengeLifetime = 5 * 60 * 1000;

export interface SealedChallenge {
  kind: CeremonyKind;
  challenge: string;
  expires: number;
  // Anything else the ceremony's finish needs, such as the link it answers.
  details: Record<string, string>;
}

// The instance table is persisted state, so its key is checked when read.
function challengeKey(db: Database): Buffer {
  const row = db.prepare("SELECT challenge_key FROM instance WHERE id = 1").get() as
    { challenge_key: Uint8Array } | undefined;
  if (row?.challenge_key.length !== 32) {
    throw new Error("the instance's challenge key is missing or malformed");
  }
  return Buffer.from(row.challenge_key);
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

// sealChallenge returns the cookie value for a ceremony's challenge.
export function sealChallenge(
  db: Database,
  now: number,
  kind: CeremonyKind,
  challenge: string,
  details: Record<string, string> = {},
): string {
  const sealed: SealedChallenge = { kind, challenge, expires: now + challengeLifetime, details };
  const payload = Buffer.from(JSON.stringify(sealed)).toString("base64url");
  return `${payload}.${mac(challengeKey(db), payload).toString("base64url")}`;
}

// openChallenge returns the challenge a cookie value seals, if the instance's
// key sealed it, it is of the kind expected and it has not expired.
export function openChallenge(
  db: Database,
  now: number,
  kind: CeremonyKind,
  cookie: string | undefined,
): SealedChallenge | undefined {
  const [payload, seal, extra] = (cookie ?? "").split(".");
  if (payload === undefined || seal === undefined || extra !== undefined) {
    return undefined;
  }
  const expected = mac(challengeKey(db), payload);
  const presented = Buffer.from(seal, "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return undefined;
  }
  // The key vouches for the payload, which only this server writes.
  const sealed = JSON.parse(Buffer.from(payload, "base64url").toString()) as SealedChallenge;
  return sealed.kind === kind && sealed.expires > now ? sealed : undefined;
}

// markChallengeUsed records a finished ceremony's challenge, inside the
// caller's transaction, and reports whether it was unused. Expired records are
// deleted first: the seal refuses their challenges anyway.
export function markChallengeUsed(db: Database, sealed: SealedChallenge, now: number): boolean {
  db.prepare("DELETE FROM used_challenges WHERE expires_at <= ?").run(now);
  const hash = createHash("sha256").update(sealed.challenge).digest();
  const inserted = db
    .prepare(
      "INSERT INTO used_challenges (hash, expires_at) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING",
    )
    .run(hash, sealed.expires);
  return inserted.changes === 1;
}
