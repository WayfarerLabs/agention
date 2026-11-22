import type { PasskeyList, SessionState, SettingsResult } from "@wayfarerlabs/agention-api";
import { type ReactNode, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { request } from "../api.ts";
import { Failure, focusLeftWith, Loadable, PageHeading, usePageTitle } from "../components.tsx";
import { useAction, useResource } from "../data.ts";
import { byteSize, plural } from "../format.tsx";
import { navigate } from "../router.tsx";
import { useSession } from "../session.tsx";
import { loadPasskeys, Passkeys, SignInAgain } from "./settings/Passkeys.tsx";
import { Voice } from "./settings/Voice.tsx";

// The Settings view: what the operator configures, in sections, their
// passkeys, voice, the space files take, which is only shown, and signing
// out. Changing passkeys or voice needs a recent
// sign-in; while this browser's is not, the view offers to sign in again
// before anything else, and the controls it holds back say why.

const loadSettings = () => request<SettingsResult>("GET", "/settings");

export function Settings() {
  usePageTitle("Settings");
  const settings = useResource<SettingsResult>(loadSettings);
  const passkeys = useResource<PasskeyList>(loadPasskeys);
  const recentHint = useId();
  const { refresh: refreshSettings } = settings;
  const { refresh: refreshPasskeys } = passkeys;
  const refresh = useCallback(() => {
    refreshSettings();
    refreshPasskeys();
  }, [refreshSettings, refreshPasskeys]);
  // The passkey list says whether the sign-in is recent, for every section;
  // until it loads, nothing is offered that needs it.
  const recent = passkeys.data?.recent === true;
  const known = passkeys.data !== undefined;
  // Once this browser has signed in again, and the offer to is gone, focus
  // goes to the first section, ahead of whatever the operator came to do.
  const [signedInAgain, setSignedInAgain] = useState(false);
  const onSignedIn = useCallback(() => {
    setSignedInAgain(true);
    refresh();
  }, [refresh]);
  return (
    <>
      <PageHeading visuallyHidden>Settings</PageHeading>
      {known && !recent && <SignInAgain hint={recentHint} onSignedIn={onSignedIn} />}
      <Section
        title="Passkeys"
        focus={signedInAgain && recent}
        focused={() => setSignedInAgain(false)}
      >
        <Loadable data={passkeys.data} failure={passkeys.failure} retry={passkeys.refresh}>
          {(data) => <Passkeys data={data} refresh={refresh} recentHint={recentHint} />}
        </Loadable>
      </Section>
      <Section title="Voice">
        <Loadable data={settings.data} failure={settings.failure} retry={settings.refresh}>
          {(data) => (
            <Voice settings={data} recent={recent} refresh={refresh} recentHint={recentHint} />
          )}
        </Loadable>
      </Section>
      <Section title="Storage">
        <Loadable data={settings.data} failure={settings.failure} retry={settings.refresh}>
          {(data) => <Storage totals={data.storage} />}
        </Loadable>
      </Section>
      <Section title="Sign out">
        <SignOut />
      </Section>
    </>
  );
}

function Section({
  title,
  focus = false,
  focused,
  children,
}: {
  title: string;
  // Whether focus goes to the section's heading, unless the operator has
  // put it somewhere since.
  focus?: boolean;
  focused?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (focus && heading.current !== null) {
      if (focusLeftWith()) {
        heading.current.focus();
      }
      focused?.();
    }
  });
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h2 id={id} ref={heading} tabIndex={-1}>
        {title}
      </h2>
      {children}
    </section>
  );
}

// Storage says how much space the files attached to messages take, pending
// uploads among them, which every backup copies.
function Storage({ totals }: { totals: SettingsResult["storage"] }) {
  return (
    <p>
      {totals.files === 0
        ? "No files are attached yet."
        : `Attachments take ${byteSize(totals.bytes)} in ${plural(totals.files, "file")}, and every backup copies them.`}
    </p>
  );
}

// SignOut ends this browser's session and goes to the sign-in page.
function SignOut() {
  const session = useSession();
  const action = useAction();
  const leave = async () => {
    const state = await action.run((csrf) =>
      request<SessionState>("POST", "/auth/signout", { csrf }),
    );
    if (state !== undefined) {
      navigate("/sign-in", { replace: true });
      session.update(state);
    }
  };
  return (
    <>
      <p className="hint">Signs this browser out. Your other browsers stay signed in.</p>
      <Failure failure={action.failure} />
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={action.pending}
          onClick={() => void leave()}
        >
          Sign out
        </button>
      </div>
    </>
  );
}
