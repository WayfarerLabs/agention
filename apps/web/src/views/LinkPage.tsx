import { useEffect, useState } from "react";
import { Failure, PageHeading, usePageTitle } from "../components.tsx";
import { useAction } from "../data.ts";
import { passkeysSupported, registerPasskey } from "../passkeys.ts";
import { navigate } from "../router.tsx";
import { serverName } from "../server-name.ts";
import { useSession } from "../session.tsx";
import { nameProblem, PasskeyNameField } from "./settings/Passkeys.tsx";
import { Unsupported } from "./SignIn.tsx";

// A passkey link's token, which travels in the URL's fragment, which browsers
// never send to a server.
export function linkOf(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? undefined;
}

// removeFragment takes the fragment out of the address bar and history.
function removeFragment() {
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );
}

// The page a passkey link opens. It reads the link and removes it from the
// address bar and history, then registers a passkey with it, under the name
// the operator gives: the first link creates the operator, and a later one
// replaces their passkeys, which the page warns of. Links come from agention
// passkey-link on the server's machine. A newer link opened in the same tab
// changes only the fragment, so the page reads each fragment that holds a
// token, and the newest link is the one used.
export function LinkPage({ operatorExists }: { operatorExists: boolean }) {
  usePageTitle("Register a passkey");
  const session = useSession();
  const [link, setLink] = useState(() => linkOf(window.location.hash));
  const action = useAction();
  const { clear } = action;
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (window.location.hash !== "") {
      removeFragment();
    }
    const takeNewerLink = () => {
      const newer = linkOf(window.location.hash);
      if (newer !== undefined) {
        removeFragment();
        setLink(newer);
        clear();
      }
    };
    window.addEventListener("hashchange", takeNewerLink);
    return () => window.removeEventListener("hashchange", takeNewerLink);
  }, [clear]);

  const register = async (token: string) => {
    const blank = nameProblem(name);
    setProblem(blank);
    if (blank !== undefined) {
      return;
    }
    const state = await action.run(() => registerPasskey(token, name));
    if (state !== undefined) {
      session.update(state);
      navigate("/", { replace: true });
    }
  };

  return (
    <div className="narrow">
      <PageHeading>Register a passkey</PageHeading>
      {!passkeysSupported() ? (
        <Unsupported />
      ) : link === undefined ? (
        <p>
          This link has no token. Run <code>agention passkey-link</code> on the server's machine for
          a new one, and open it as given.
        </p>
      ) : (
        <>
          <p>
            {operatorExists
              ? "This registers a passkey on this device."
              : "This creates you as Agention's operator, with a passkey on this device."}{" "}
            The link works once and expires 15 minutes after it was made.
          </p>
          {operatorExists && (
            <p className="notice warning">
              Finishing replaces every {serverName()} passkey you have with this one, and signs out
              every browser.
            </p>
          )}
          <Failure failure={action.failure} />
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void register(link);
            }}
          >
            <PasskeyNameField
              label="Passkey name"
              value={name}
              onChange={setName}
              problem={problem}
            />
            <div className="actions">
              <button type="submit" disabled={action.pending}>
                Create a passkey
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
