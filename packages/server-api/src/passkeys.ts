import { name, singleLineText } from "@wayfarerlabs/agention-api";
import { z } from "zod";

// The web UI's sign-in: passkeys, the browser session they open, the links
// that register the operator's passkeys, and the operator's own list of them.

// A 256-bit secret in unpadded base64url, written canonically, such as the
// token of a passkey link.
export const secretToken = z
  .string()
  // cspell:disable-next-line
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "must be a 256-bit base64url token");

// Whether the browser is signed in. Signed in, it carries the operator's name
// and the token every mutation must send in X-CSRF-Token; signed out, it says
// whether an operator exists yet, since until the first passkey link creates
// one, signing in is impossible.
export const sessionState = z.discriminatedUnion("signed_in", [
  z.object({
    signed_in: z.literal(true),
    operator: z.object({ name }),
    csrf_token: z.string(),
  }),
  z.object({ signed_in: z.literal(false), operator_exists: z.boolean() }),
]);
export type SessionState = z.infer<typeof sessionState>;

// The options a ceremony's begin step returns, in the WebAuthn JSON form the
// browser's PublicKeyCredential.parseCreationOptionsFromJSON and
// parseRequestOptionsFromJSON read.
export const passkeyOptions = z.object({ options: z.record(z.string(), z.unknown()) });
export type PasskeyOptions = z.infer<typeof passkeyOptions>;

// What the operator calls a passkey, such as the device that holds it.
export const passkeyName = singleLineText({ min: 1, max: 50 });

// Starting a passkey link takes the token from the link's URL fragment, and
// the name of the passkey it registers.
export const passkeyLinkBeginInput = z.object({ token: secretToken, name: passkeyName });
export type PasskeyLinkBeginInput = z.infer<typeof passkeyLinkBeginInput>;

// Adding a passkey on this device, and renaming one, take its name.
export const passkeyNameInput = z.object({ name: passkeyName });
export type PasskeyNameInput = z.infer<typeof passkeyNameInput>;

function base64url(max: number) {
  return z
    .string()
    .max(max)
    .regex(/^[A-Za-z0-9_-]*$/, "must be base64url");
}

// A credential id is at most 1,023 bytes.
const credentialId = base64url(1364).min(1);

// An optional member the answer may also carry as null: what it mirrors is
// nullable, and some browsers and passkey managers copy that null into the
// JSON instead of leaving the member out. Either way it is absent.
function absentWhenNull<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

// The members both answers share. Neither answer takes clientExtensionResults:
// the server and its WebAuthn library never read it, and passkey managers such
// as 1Password leave it out of a sign-in.
const credentialFields = {
  id: credentialId,
  rawId: credentialId,
  authenticatorAttachment: absentWhenNull(z.string().max(32)),
  type: z.literal("public-key"),
};

// PublicKeyCredential.toJSON() of a newly created passkey.
export const passkeyRegistration = z.object({
  ...credentialFields,
  response: z.object({
    clientDataJSON: base64url(16_384),
    attestationObject: base64url(65_536),
    authenticatorData: base64url(16_384).optional(),
    transports: z.array(z.string().max(32)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: absentWhenNull(base64url(4096)),
  }),
});

// PublicKeyCredential.toJSON() of a sign-in assertion.
export const passkeyAssertion = z.object({
  ...credentialFields,
  response: z.object({
    clientDataJSON: base64url(16_384),
    authenticatorData: base64url(16_384),
    signature: base64url(2048),
    userHandle: absentWhenNull(base64url(128)),
  }),
});

// Finishing a link, or adding a passkey on this device, sends the new
// passkey; finishing a sign-in sends the assertion. The challenge each answers
// travels in a cookie.
export const newPasskeyInput = z.object({ credential: passkeyRegistration });
export type NewPasskeyInput = z.infer<typeof newPasskeyInput>;

export const signInFinishInput = z.object({ credential: passkeyAssertion });
export type SignInFinishInput = z.infer<typeof signInFinishInput>;

export const passkeyId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// One of the operator's passkeys. current says it signed this browser in.
export const passkeySummary = z.object({
  id: passkeyId,
  name: z.string(),
  created_at: z.string(),
  last_used_at: z.string().optional(),
  current: z.boolean(),
});
export type PasskeySummary = z.infer<typeof passkeySummary>;

// The operator's passkeys, oldest first, and whether this browser signed in
// recently enough to add a passkey or remove one.
export const passkeyList = z.object({
  passkeys: z.array(passkeySummary),
  recent: z.boolean(),
});
export type PasskeyList = z.infer<typeof passkeyList>;

// Removing a passkey ends the browser sessions it signed in; signed_out says
// this browser's was one of them.
export const passkeyRemoved = z.object({ signed_out: z.boolean() });
export type PasskeyRemoved = z.infer<typeof passkeyRemoved>;
