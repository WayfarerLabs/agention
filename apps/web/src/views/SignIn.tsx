import { Failure, PageHeading, usePageTitle } from "../components.tsx";
import { useAction } from "../data.ts";
import { passkeysSupported, signIn } from "../passkeys.ts";
import { serverName } from "../server-name.ts";
import { useSession } from "../session.tsx";

// Unsupported says the browser lacks what signing in needs.
export function Unsupported() {
  return (
    <div className="notice danger" role="alert">
      <p>
        This browser cannot sign in to {serverName()}: it lacks the passkey support Agention needs.
        Use a current version of Safari, Chrome, Edge or Firefox.
      </p>
    </div>
  );
}

// The sign-in page: a usernameless passkey sign-in. Until a passkey link has
// created the operator, there is no one to sign in as, and the page says how
// to make that link.
export function SignIn({ operatorExists }: { operatorExists: boolean }) {
  usePageTitle("Sign in");
  const session = useSession();
  const action = useAction();

  const start = async () => {
    const state = await action.run(signIn);
    if (state !== undefined) {
      session.update(state);
    }
  };

  return (
    <div className="narrow">
      <PageHeading>Sign in</PageHeading>
      {!passkeysSupported() ? (
        <Unsupported />
      ) : !operatorExists ? (
        <>
          <p>
            Agention has no operator yet. To create yourself with a passkey, run this on the
            server's machine:
          </p>
          <pre className="command">
            <code>agention passkey-link --data DIR --origin {window.location.origin}</code>
          </pre>
          <p>Then open the link it prints, in the browser you want to sign in with.</p>
        </>
      ) : (
        <>
          <p>Sign in with your {serverName()} passkey.</p>
          <Failure failure={action.failure} />
          <div className="actions">
            <button type="button" disabled={action.pending} onClick={() => void start()}>
              Sign in with a passkey
            </button>
          </div>
          <p className="hint">
            Lost your passkeys? Run <code>agention passkey-link</code> on the server's machine for a
            link that replaces them.
          </p>
        </>
      )}
    </div>
  );
}
