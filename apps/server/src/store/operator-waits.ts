import type { Credential } from "../identity.ts";

// How many of the operator's waits across every session one credential, an
// API key or a browser session, may hold at once. Every message wakes every
// such wait to poll again, so a credential holding many multiplies what each
// message costs.
export const maxOperatorWaits = 4;

// OperatorWaits counts the operator's waits across every session that each
// credential holds, up to maxOperatorWaits. A wait takes a place before it
// starts and gives it back however it ends; one past the limit takes none
// and is refused, so no wait ever ends to make room for another, which would
// let clients that each wait again push each other out. The count lives in
// the server process, as the waits do.
export class OperatorWaits {
  readonly #held = new Map<string, number>();

  // take takes a place for a wait on the credential and answers what gives
  // it back, or undefined when the credential holds the limit already.
  take(credential: Credential): (() => void) | undefined {
    const key = keyOf(credential);
    const held = this.#held.get(key) ?? 0;
    if (held >= maxOperatorWaits) {
      return undefined;
    }
    this.#held.set(key, held + 1);
    // Giving a place back twice would free one another wait holds, and let
    // the credential past the limit, so only the first time counts.
    let given = false;
    return () => {
      if (given) {
        return;
      }
      given = true;
      // The key is held while any of its places is.
      const left = (this.#held.get(key) as number) - 1;
      if (left === 0) {
        this.#held.delete(key);
      } else {
        this.#held.set(key, left);
      }
    };
  }

  // holding counts the places the credential holds.
  holding(credential: Credential): number {
    return this.#held.get(keyOf(credential)) ?? 0;
  }
}

// A credential's key among the counts, one for each credential.
function keyOf(credential: Credential): string {
  switch (credential.kind) {
    case "api_key":
      return `api_key:${credential.id}`;
    case "registration":
      return `registration:${credential.registrationId}`;
    case "browser_session":
      return `browser_session:${Buffer.from(credential.hash).toString("hex")}`;
  }
}
