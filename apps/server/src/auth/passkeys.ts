import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  NewPasskeyInput,
  PasskeyOptions,
  SignInFinishInput,
} from "@wayfarerlabs/agention-api";
import { randomBytes } from "node:crypto";
import type { Database } from "../database/database.ts";
import { invalidInput, unauthenticated } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { findOperator, insertOperator, type Store } from "../store/index.ts";
import {
  closeBrowserSession,
  type OpenedBrowserSession,
  openBrowserSession,
  requireRecentSignIn,
  signedInSession,
} from "./browser-sessions.ts";
import { consumePasskeyLink, findPasskeyLink } from "./passkey-links.ts";
import {
  challengeLifetime,
  markChallengeUsed,
  openChallenge,
  type SealedChallenge,
  sealChallenge,
} from "./sealed-challenges.ts";

// The passkey ceremonies: sign-in, the link that registers a passkey of the
// operator's, and adding one on the device in hand. Each runs in two requests.
// Begin returns the options for the browser and the sealed challenge for its
// cookie, and stores nothing; finish verifies the browser's answer to that
// challenge, and a sign-in or a link opens a browser session.
// Passkeys must verify the user (a PIN or biometric, not just presence) and be
// discoverable, so sign-in names no one and reveals nothing about who exists.

// The site passkeys are bound to: the exact origin, and its host as the
// relying party id; and the server's name, which a passkey manager shows
// beside a new passkey.
export interface RelyingParty {
  origin: string;
  id: string;
  name: string;
}

export function relyingParty(origin: string, name: string): RelyingParty {
  return { origin, id: new URL(origin).hostname, name };
}

export interface Ceremony {
  options: PasskeyOptions["options"];
  // The challenge cookie's value.
  sealedChallenge: string;
}

export interface SignedIn {
  session: OpenedBrowserSession;
  operatorName: string;
}

// What a passkeys row's data column holds. The user handle is the WebAuthn
// user id, kept the same across replacements so an authenticator overwrites
// the operator's old passkey instead of keeping a dead one beside it.
interface PasskeyData {
  public_key: string;
  counter: number;
  transports: string[];
  user_handle: string;
  device_type: string;
  backed_up: boolean;
}

// The data column is persisted state, so it is checked when read.
function passkeyData(text: string): PasskeyData {
  const data = JSON.parse(text) as Partial<PasskeyData>;
  if (
    typeof data.public_key !== "string" ||
    typeof data.counter !== "number" ||
    !Array.isArray(data.transports) ||
    typeof data.user_handle !== "string"
  ) {
    throw new Error("a stored passkey is malformed");
  }
  return data as PasskeyData;
}

// The browser marks an answer given inside a frame of another site. Agention's
// pages refuse to be framed, so such an answer is never genuine.
function refuseCrossOrigin(clientDataJSON: string): void {
  let crossOrigin: unknown;
  try {
    ({ crossOrigin } = decodeClientDataJSON(clientDataJSON));
  } catch {
    throw unauthenticated("the passkey's answer is malformed");
  }
  if (crossOrigin === true) {
    throw unauthenticated("the passkey answered inside another site's frame");
  }
}

// The public key algorithms passkeys may use: Ed25519, P-256 and RSA, which
// every authenticator offers one of. The library would add ML-DSA where the
// runtime has it, which in Node is still experimental.
const supportedAlgorithmIDs = [-8, -7, -257];

const notVerified = () => unauthenticated("the passkey could not be verified");

const challengeGone = () =>
  unauthenticated("the passkey ceremony expired or was not started here; start again");

const linkGone = () =>
  unauthenticated("the passkey link was used, replaced or expired; make a new one");

export async function beginSignIn(store: Store, rp: RelyingParty): Promise<Ceremony> {
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: [],
    userVerification: "required",
    timeout: challengeLifetime,
  });
  return {
    options: { ...options },
    sealedChallenge: sealChallenge(store.db, store.clock(), "signin", options.challenge),
  };
}

// finishSignIn verifies a sign-in assertion and opens a browser session,
// closing the one the browser held before, if any.
export async function finishSignIn(
  store: Store,
  rp: RelyingParty,
  sealedChallenge: string | undefined,
  input: SignInFinishInput,
  previousSession: string | undefined,
): Promise<SignedIn> {
  const { db } = store;
  const challenge = openChallenge(db, store.clock(), "signin", sealedChallenge);
  if (challenge === undefined) {
    throw challengeGone();
  }
  const { credential } = input;
  refuseCrossOrigin(credential.response.clientDataJSON);
  const stored = db
    .prepare("SELECT id, person_id, data FROM passkeys WHERE credential_id = ?")
    .get(credential.id) as { id: number; person_id: number; data: string } | undefined;
  if (stored === undefined) {
    throw unauthenticated("this passkey is not registered here");
  }
  const data = passkeyData(stored.data);
  if (credential.response.userHandle !== data.user_handle) {
    throw notVerified();
  }
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: credential.id,
        publicKey: isoBase64URL.toBuffer(data.public_key),
        counter: data.counter,
        transports: data.transports,
      },
      requireUserVerification: true,
    });
  } catch {
    throw notVerified();
  }
  if (!verification.verified) {
    throw notVerified();
  }
  const { newCounter, credentialBackedUp } = verification.authenticationInfo;
  return db.transaction(() => {
    const now = store.clock();
    if (!markChallengeUsed(db, challenge, now)) {
      throw challengeGone();
    }
    // The assertion was verified against the row read above; the update
    // applies only if that row is unchanged, so a concurrent sign-in, or a
    // link that replaced the passkeys meanwhile, fails.
    const updated = db
      .prepare("UPDATE passkeys SET data = ?, last_used_at = ? WHERE id = ? AND data = ?")
      .run(
        JSON.stringify({ ...data, counter: newCounter, backed_up: credentialBackedUp }),
        now,
        stored.id,
        stored.data,
      );
    if (updated.changes !== 1) {
      throw notVerified();
    }
    closeBrowserSession(db, previousSession, now);
    const operator = findOperator(db);
    if (operator === undefined) {
      throw notVerified();
    }
    return {
      session: openBrowserSession(db, stored.person_id, stored.id, now),
      operatorName: operator.name,
    };
  });
}

// The most passkeys the operator holds.
export const maxPasskeys = 20;

interface HeldPasskeys {
  // The WebAuthn user id the operator's passkeys share.
  userHandle: string;
  // Their credentials, for an authenticator to refuse to add one it holds.
  credentials: { id: string; transports: string[] }[];
}

// heldPasskeys reads the operator's passkeys, if they hold any.
function heldPasskeys(db: Database, personId: number): HeldPasskeys | undefined {
  const held = (
    db.prepare("SELECT credential_id, data FROM passkeys WHERE person_id = ?").all(personId) as {
      credential_id: string;
      data: string;
    }[]
  ).map((row) => ({ id: row.credential_id, data: passkeyData(row.data) }));
  const [first] = held;
  return first === undefined
    ? undefined
    : {
        userHandle: first.data.user_handle,
        credentials: held.map(({ id, data }) => ({ id, transports: data.transports })),
      };
}

// roomFor refuses to add a passkey beyond the most the operator holds, and
// returns the passkeys they do.
function roomFor(held: HeldPasskeys | undefined): HeldPasskeys {
  if (held === undefined) {
    throw new Error("a passkey is being added, but the operator holds none");
  }
  if (held.credentials.length >= maxPasskeys) {
    throw tooMany();
  }
  return held;
}

const tooMany = () =>
  invalidInput(
    undefined,
    `you hold ${maxPasskeys} passkeys, the most Agention keeps; remove one before adding another`,
  );

// passkeyUserName is the user name and display name a passkey made on the
// server carries: the server's name and the operator's, as in "Work · morgan",
// the server's first so that an authenticator shortening a long user name
// keeps it. A passkey belongs to a host name, so servers sharing one under
// different ports tell their passkeys apart by it in the browser's list.
const passkeyUserName = (operatorName: string, rp: RelyingParty) => `${rp.name} · ${operatorName}`;

// registrationOptions asks for a discoverable, user-verifying passkey under
// the operator's user handle, other than those excluded.
async function registrationOptions(
  rp: RelyingParty,
  operatorName: string,
  userHandle: string,
  exclude: { id: string; transports: string[] }[],
) {
  const userName = passkeyUserName(operatorName, rp);
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName,
    userDisplayName: userName,
    userID: isoBase64URL.toBuffer(userHandle),
    attestationType: "none",
    excludeCredentials: exclude,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs,
    timeout: challengeLifetime,
  });
}

interface NewPasskey {
  credentialId: string;
  data: PasskeyData;
}

// verifyNewPasskey verifies a new passkey's answer to a sealed challenge.
async function verifyNewPasskey(
  rp: RelyingParty,
  challenge: SealedChallenge,
  input: NewPasskeyInput,
  userHandle: string,
): Promise<NewPasskey> {
  const { credential } = input;
  refuseCrossOrigin(credential.response.clientDataJSON);
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: credential as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      supportedAlgorithmIDs,
    });
  } catch {
    throw notVerified();
  }
  if (!verification.verified) {
    throw notVerified();
  }
  const created = verification.registrationInfo;
  return {
    credentialId: created.credential.id,
    data: {
      public_key: isoBase64URL.fromBuffer(created.credential.publicKey),
      counter: created.credential.counter,
      transports: created.credential.transports ?? [],
      user_handle: userHandle,
      device_type: created.credentialDeviceType,
      backed_up: created.credentialBackedUp,
    },
  };
}

// insertPasskey stores a new passkey of the person's, inside the caller's
// transaction, refusing one already registered or beyond the most they hold,
// which ceremonies finishing side by side could otherwise pass, and returns
// its id.
function insertPasskey(
  db: Database,
  personId: number,
  passkey: NewPasskey,
  name: string,
  now: number,
  usedAt: number | null,
): number {
  if (
    db.prepare("SELECT 1 FROM passkeys WHERE credential_id = ?").get(passkey.credentialId) !==
    undefined
  ) {
    throw invalidInput("credential", "this passkey is already registered here");
  }
  const { held } = db
    .prepare("SELECT count(*) AS held FROM passkeys WHERE person_id = ?")
    .get(personId) as { held: number };
  if (held >= maxPasskeys) {
    throw tooMany();
  }
  const { id } = db
    .prepare(
      `INSERT INTO passkeys (person_id, credential_id, name, data, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(personId, passkey.credentialId, name, JSON.stringify(passkey.data), now, usedAt) as {
    id: number;
  };
  return id;
}

// beginLink starts registering a passkey, named name, through a link's token.
export async function beginLink(
  store: Store,
  rp: RelyingParty,
  token: string,
  name: string,
): Promise<Ceremony> {
  const { db } = store;
  const found = findPasskeyLink(db, token, store.clock());
  if (found === undefined) {
    throw linkGone();
  }
  const operator = findOperator(db);
  const operatorName = operator?.name ?? found.operatorName;
  const held = operator === undefined ? undefined : heldPasskeys(db, operator.personId);
  // A replacement keeps the user handle the operator's passkeys share.
  const userHandle = held?.userHandle ?? randomBytes(32).toString("base64url");
  const options = await registrationOptions(rp, operatorName, userHandle, []);
  return {
    options: { ...options },
    sealedChallenge: sealChallenge(db, store.clock(), "link", options.challenge, {
      link: found.hash.toString("base64url"),
      user_handle: userHandle,
      name,
    }),
  };
}

// finishLink verifies the new passkey and, in one transaction that also
// consumes the link, stores it and opens a session for this browser. The link
// creates the operator or replaces their passkeys, which ends every browser
// session they signed in, this browser's included.
export async function finishLink(
  store: Store,
  rp: RelyingParty,
  sealedChallenge: string | undefined,
  input: NewPasskeyInput,
): Promise<SignedIn> {
  const { db } = store;
  const challenge = openChallenge(db, store.clock(), "link", sealedChallenge);
  const { link, user_handle: userHandle, name } = challenge?.details ?? {};
  if (
    challenge === undefined ||
    link === undefined ||
    userHandle === undefined ||
    name === undefined
  ) {
    throw challengeGone();
  }
  const passkey = await verifyNewPasskey(rp, challenge, input, userHandle);
  return db.transaction(() => {
    const now = store.clock();
    if (!markChallengeUsed(db, challenge, now)) {
      throw challengeGone();
    }
    const operatorName = consumePasskeyLink(db, Buffer.from(link, "base64url"), now);
    if (operatorName === undefined) {
      throw linkGone();
    }
    let operator = findOperator(db);
    if (operator === undefined) {
      operator = insertOperator(db, operatorName, now);
    } else {
      db.prepare("DELETE FROM passkeys WHERE person_id = ?").run(operator.personId);
    }
    const passkeyId = insertPasskey(db, operator.personId, passkey, name, now, now);
    return {
      session: openBrowserSession(db, operator.personId, passkeyId, now),
      operatorName: operator.name,
    };
  });
}

// beginAdding starts adding a passkey, named name, on the device in hand. It
// needs a recent sign-in, and asks for a passkey other than those the
// operator holds.
export async function beginAdding(
  store: Store,
  rp: RelyingParty,
  identity: Identity,
  name: string,
): Promise<Ceremony> {
  const { db } = store;
  const { operatorName, userHandle, exclude } = db.transaction(() => {
    const session = signedInSession(db, identity, store.clock());
    requireRecentSignIn(session);
    const operator = findOperator(db);
    if (operator === undefined) {
      throw new Error("a signed-in browser has no operator");
    }
    const held = roomFor(heldPasskeys(db, session.personId));
    return { operatorName: operator.name, userHandle: held.userHandle, exclude: held.credentials };
  });
  const options = await registrationOptions(rp, operatorName, userHandle, exclude);
  return {
    options: { ...options },
    sealedChallenge: sealChallenge(db, store.clock(), "add", options.challenge, {
      user_handle: userHandle,
      name,
    }),
  };
}

// finishAdding verifies the new passkey and stores it beside the operator's
// others, while the sign-in is still recent. The browser stays signed in with
// the passkey it signed in with.
export async function finishAdding(
  store: Store,
  rp: RelyingParty,
  sealedChallenge: string | undefined,
  identity: Identity,
  input: NewPasskeyInput,
): Promise<void> {
  const { db } = store;
  const challenge = openChallenge(db, store.clock(), "add", sealedChallenge);
  const { user_handle: userHandle, name } = challenge?.details ?? {};
  if (challenge === undefined || userHandle === undefined || name === undefined) {
    throw challengeGone();
  }
  const passkey = await verifyNewPasskey(rp, challenge, input, userHandle);
  db.transaction(() => {
    const now = store.clock();
    const session = signedInSession(db, identity, now);
    requireRecentSignIn(session);
    if (!markChallengeUsed(db, challenge, now)) {
      throw challengeGone();
    }
    insertPasskey(db, session.personId, passkey, name, now, null);
  });
}
