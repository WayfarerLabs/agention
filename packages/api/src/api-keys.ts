import { z } from "zod";
import { scope } from "./scopes.ts";
import { singleLineText } from "./text.ts";
import { timestamp } from "./time.ts";

// API keys, which the operator creates in Settings for a client to call the
// operator API as them, within the key's scopes. Keys are managed only on the
// web mount, behind a passkey; no key can manage keys.

// The operator holds at most this many keys that are neither revoked nor
// expired.
export const maxApiKeys = 20;

// A key's secret: agention_ and 256 random bits in unpadded base64url, so
// people and secret scanners recognize one.
export const apiKeyPrefix = "agention_";
export const apiKeySecret = z
  .string()
  // cspell:disable-next-line
  .regex(/^agention_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "must be an Agention API key");

// What the operator calls a key, such as the client that holds it.
export const apiKeyName = singleLineText({ min: 1, max: 50 });

export const apiKeyId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// The days a key may last, counted from its creation.
export const apiKeyDays = [7, 30, 60, 90] as const;

// The furthest a chosen expiry date may be, from the key's creation.
export const maxApiKeyLifetimeDays = 365;

// A key's expiry: a number of days, a time up to a year away, or none, which
// a key's holder can use until the operator revokes it.
export const apiKeyExpiry = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("days"),
    days: z.union(apiKeyDays.map((days) => z.literal(days))),
  }),
  z.object({
    kind: z.literal("date"),
    at: timestamp.describe(
      `when the key expires: after the key's creation and at most ${maxApiKeyLifetimeDays} ` +
        "days after it",
    ),
  }),
  z.object({ kind: z.literal("none") }),
]);
export type ApiKeyExpiry = z.infer<typeof apiKeyExpiry>;

// The scopes a key holds: at least one, each once.
export const apiKeyScopes = z
  .array(scope)
  .min(1)
  .max(scope.options.length)
  .refine((all) => new Set(all).size === all.length, "must not repeat a scope")
  .describe("the scopes the key holds, each once");

export const apiKeyCreateInput = z.object({
  name: apiKeyName,
  scopes: apiKeyScopes,
  expiry: apiKeyExpiry,
});
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateInput>;

// A key as the operator's list shows it. A revoked or expired key stays
// listed, with its status, until the operator next creates or revokes a key.
export const apiKeyStatus = z.enum(["active", "expired", "revoked"]);
export type ApiKeyStatus = z.infer<typeof apiKeyStatus>;

export const apiKeySummary = z.object({
  id: apiKeyId,
  name: z.string(),
  scopes: z.array(scope),
  status: apiKeyStatus,
  created_at: z.string(),
  expires_at: z.string().optional(),
  last_used_at: z.string().optional().describe("when the key was last used, to within an hour"),
  revoked_at: z.string().optional(),
});
export type ApiKeySummary = z.infer<typeof apiKeySummary>;

// The operator's keys, newest first, and whether this browser signed in
// recently enough to create or revoke one.
export const apiKeyList = z.object({ keys: z.array(apiKeySummary), recent: z.boolean() });
export type ApiKeyList = z.infer<typeof apiKeyList>;

// A new key, with its secret, which the server answers this once and never
// again.
export const apiKeyCreated = z.object({ key: apiKeySummary, secret: apiKeySecret });
export type ApiKeyCreated = z.infer<typeof apiKeyCreated>;

export const apiKeyRevoked = z.object({ key: apiKeySummary });
export type ApiKeyRevoked = z.infer<typeof apiKeyRevoked>;

// The versions of the operator API the server serves, at /api/operator; each
// is served under /api/operator/v<version>/.
export const operatorApiVersions = z.object({ versions: z.array(z.number().int().min(1)) });
export type OperatorApiVersions = z.infer<typeof operatorApiVersions>;
