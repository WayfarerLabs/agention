import type { PasskeyList } from "@wayfarerlabs/agention-server-api";
import { useLayoutEffect, useState } from "react";
import { ApiFailure, request } from "../../api.ts";
import { Failure, focusLeftWith } from "../../components.tsx";
import { type Resource, useAction, useResource } from "../../data.ts";
import { passkeysSupported, signIn } from "../../passkeys.ts";
import { useSession } from "../../session.tsx";

// A change to a secret in Settings, such as adding a passkey or saving where
// voice sends recordings, needs a recent sign-in. Each section that makes one
// offers, while this browser's sign-in is not recent, to sign in again, and
// the controls it holds back say why, through the offer's hint.

// The passkey list, which is where the API says whether the sign-in is
// recent.
export const loadPasskeys = () => request<PasskeyList>("GET", "/passkeys");

// useRecentSignIn loads whether this browser's sign-in is recent, for a
// section that does not show the passkey list itself.
export function useRecentSignIn(): Resource<boolean> {
  const passkeys = useResource(loadPasskeys);
  return { ...passkeys, data: passkeys.data?.recent };
}

// needingRecent runs a change that needs a recent sign-in. When the server
// finds the sign-in too old, though the page last saw it recent, the page
// reads it again, so it offers to sign in again.
export async function needingRecent<T>(change: Promise<T>, refresh: () => void): Promise<T> {
  try {
    return await change;
  } catch (failure) {
    if (failure instanceof ApiFailure && failure.code === "not_allowed") {
      refresh();
    }
    throw failure;
  }
}

export const unsupported =
  "This browser lacks the passkey support Agention needs, so it cannot do this.";

// RecentSignIn is the offer, shown while the sign-in is known not to be
// recent: why the section's changes are unavailable, what it says in its
// hint, and a sign-in again, which replaces this browser's session with a
// recent one. need names those changes, as "Adding or removing a passkey".
// Once signed in again, refresh reads the sign-in again; when it is recent
// and the offer goes, focus goes to the section's heading, ahead of whatever
// the operator came to do, unless they have put it somewhere since.
export function RecentSignIn({
  recent,
  need,
  hint,
  refresh,
  focusHeading,
}: {
  recent: boolean | undefined;
  need: string;
  hint: string;
  refresh: () => void;
  focusHeading: () => void;
}) {
  const session = useSession();
  const action = useAction();
  const [signedInAgain, setSignedInAgain] = useState(false);
  useLayoutEffect(() => {
    if (signedInAgain && recent === true) {
      setSignedInAgain(false);
      if (focusLeftWith()) {
        focusHeading();
      }
    }
  }, [signedInAgain, recent, focusHeading]);
  if (recent !== false) {
    return null;
  }
  const again = async () => {
    const state = await action.run(signIn);
    if (state !== undefined) {
      session.update(state);
      setSignedInAgain(true);
      refresh();
    }
  };
  return (
    <div className="notice">
      <p id={hint}>{need} needs a sign-in within the last 10 minutes.</p>
      <Failure failure={action.failure} />
      {passkeysSupported() ? (
        <div className="actions">
          <button type="button" disabled={action.pending} onClick={() => void again()}>
            Sign in again
          </button>
        </div>
      ) : (
        <p>{unsupported}</p>
      )}
    </div>
  );
}
