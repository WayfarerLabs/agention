import type { PasskeyOptions, SessionState } from "@wayfarerlabs/agention-api";
import { PasskeyFailure, request } from "./api.ts";
import { serverName } from "./server-name.ts";

// Passkey ceremonies, through the browser's WebAuthn JSON helpers: the
// server's options in WebAuthn's JSON form go in, and the credential's own
// JSON form goes back, so the page never handles binary fields.

// passkeysSupported says whether this browser has the helpers Agention needs.
export function passkeysSupported(): boolean {
  return (
    typeof window.PublicKeyCredential === "function" &&
    typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function" &&
    typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials.get === "function"
  );
}

// The browser's answer, in its JSON form. A passkey manager can hand back its
// own credential object; one without toJSON cannot be sent.
function credentialJson(
  credential: Credential | null,
): RegistrationResponseJSON | AuthenticationResponseJSON {
  const answer = credential as PublicKeyCredential | null;
  if (typeof answer?.toJSON !== "function") {
    throw new PasskeyFailure(
      "The passkey's answer cannot be read in this browser. Try another browser or passkey manager.",
    );
  }
  return answer.toJSON();
}

// The browser refuses or abandons a ceremony with a DOMException; NotAllowed
// covers both cancelling and timing out.
function ceremonyFailure(error: unknown): Error {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
      return new PasskeyFailure("The passkey request was cancelled or timed out.");
    }
    if (error.name === "InvalidStateError") {
      return new PasskeyFailure(`This authenticator already holds a passkey for ${serverName()}.`);
    }
    return new PasskeyFailure(`The browser refused the passkey request: ${error.message}`);
  }
  return error instanceof Error ? error : new PasskeyFailure("The passkey request failed.");
}

// signIn runs a usernameless sign-in and returns the signed-in session.
export async function signIn(): Promise<SessionState> {
  const { options } = await request<PasskeyOptions>("POST", "/auth/signin/begin");
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(
        options as unknown as PublicKeyCredentialRequestOptionsJSON,
      ),
    });
  } catch (error) {
    throw ceremonyFailure(error);
  }
  return request<SessionState>("POST", "/auth/signin/finish", {
    body: { credential: credentialJson(credential) },
  });
}

// createPasskey has the browser create a passkey for registration options.
async function createPasskey(options: PasskeyOptions["options"]) {
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(
        options as unknown as PublicKeyCredentialCreationOptionsJSON,
      ),
    });
  } catch (error) {
    throw ceremonyFailure(error);
  }
  return credentialJson(credential);
}

// registerPasskey uses a passkey link's token to register a new passkey under
// the name given, and returns the signed-in session.
export async function registerPasskey(token: string, name: string): Promise<SessionState> {
  const { options } = await request<PasskeyOptions>("POST", "/auth/link/begin", {
    body: { token, name },
  });
  return request<SessionState>("POST", "/auth/link/finish", {
    body: { credential: await createPasskey(options) },
  });
}

// addPasskey adds a passkey on this device under the name given.
export async function addPasskey(name: string, csrf: string | undefined): Promise<void> {
  const { options } = await request<PasskeyOptions>("POST", "/passkeys/register/begin", {
    csrf,
    body: { name },
  });
  await request("POST", "/passkeys/register/finish", {
    csrf,
    body: { credential: await createPasskey(options) },
  });
}
