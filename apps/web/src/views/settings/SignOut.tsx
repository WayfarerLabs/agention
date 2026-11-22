import type { SessionState } from "@wayfarerlabs/agention-api";
import { request } from "../../api.ts";
import { Failure } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { navigate } from "../../router.tsx";
import { useSession } from "../../session.tsx";

// SignOutSection ends this browser's session and goes to the sign-in page.
export function SignOutSection() {
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
