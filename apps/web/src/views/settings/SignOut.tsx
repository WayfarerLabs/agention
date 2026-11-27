import type { SessionState } from "@wayfarerlabs/agention-server-api";
import { request } from "../../api.ts";
import { Failure } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { forgetDrafts } from "../../device.ts";
import { navigate } from "../../router.tsx";
import { useSession } from "../../session.tsx";

// SignOutSection ends this browser's session and goes to the sign-in page,
// forgetting the drafts the browser kept, since another person may use it
// next.
export function SignOutSection() {
  const session = useSession();
  const action = useAction();
  const leave = async () => {
    // From here the page asks nothing more that needs the session.
    const release = session.signingOut();
    const state = await action.run((csrf) =>
      request<SessionState>("POST", "/auth/signout", { csrf }),
    );
    if (state === undefined) {
      release();
    } else {
      forgetDrafts();
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
