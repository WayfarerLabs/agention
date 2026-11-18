import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchRoute, safeReturnPath } from "./router.tsx";
import {
  csrf,
  FakeApi,
  failure,
  installPasskeys,
  message,
  renderAt,
  signedIn,
  threadAnswer,
  threadSummary,
  titled,
} from "./test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
  Reflect.deleteProperty(navigator, "credentials");
});

const signedOut = { signed_in: false, operator_exists: true } as const;

describe("routes", () => {
  it.each([
    ["/", { name: "threads" }],
    ["/registrations", { name: "registrations" }],
    ["/passkeys", { name: "passkeys" }],
    ["/sign-in", { name: "sign-in" }],
    ["/link", { name: "link" }],
    [
      "/s/builder/main/threads/12",
      { name: "thread", agent: "builder", session: "main", thread: 12 },
    ],
    ["/s/Builder/main/threads/12", { name: "not-found" }],
    ["/s/builder/main/threads/0", { name: "not-found" }],
    ["/s/builder/main/threads/12/", { name: "not-found" }],
    ["/elsewhere", { name: "not-found" }],
  ])("read %s", (path, route) => {
    expect(matchRoute(path)).toEqual(route);
  });

  it.each([
    ["/s/builder/main/threads/3?x=1", "/s/builder/main/threads/3?x=1"],
    [
      "/?status=open&effort=quick&include_archived=true&sort=due",
      "/?status=open&effort=quick&include_archived=true&sort=due",
    ],
    ["//evil.example/", "/"],
    ["https://evil.example/", "/"],
    ["/\\evil.example", "/"],
    ["/sign-in", "/"],
    ["/nowhere", "/"],
    [null, "/"],
  ])("return after sign-in to %s as %s", (next, expected) => {
    expect(safeReturnPath(next)).toBe(expected);
  });
});

describe("signing in", () => {
  it("sends a signed-out browser from a private route to sign-in, keeping the route", async () => {
    api.on("GET", "/session", { body: signedOut });
    renderAt("/s/builder/main/threads/3");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(window.location.pathname + window.location.search).toBe(
      `/sign-in?next=${encodeURIComponent("/s/builder/main/threads/3")}`,
    );
  });

  it("says to run passkey-link before any operator exists", async () => {
    installPasskeys({});
    api.on("GET", "/session", { body: { signed_in: false, operator_exists: false } });
    renderAt("/sign-in");
    await screen.findByRole("heading", { name: "Sign in" });
    // The command to run names this server's origin.
    const command = screen.getByText(window.location.origin, { exact: false });
    expect(command.closest("code")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
  });

  it("tells a browser without WebAuthn's JSON helpers that it cannot sign in", async () => {
    api.on("GET", "/session", { body: signedOut });
    renderAt("/sign-in");
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
  });

  it("signs in with a passkey and returns to the route that needed it", async () => {
    const assertion = {
      id: "cred",
      rawId: "cred",
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: "e30",
        authenticatorData: "AA",
        signature: "AA",
        // cspell:disable-next-line
        userHandle: "dXNlcg",
      },
    };
    const { FakePublicKeyCredential } = installPasskeys(assertion);
    api
      .on("GET", "/session", { body: signedOut })
      .on("POST", "/auth/signin/begin", {
        body: { options: { challenge: "abc", rpId: "agention.test" } },
      })
      .on("POST", "/auth/signin/finish", { body: signedIn });
    renderAt(`/sign-in?next=${encodeURIComponent("/?unread=true")}`);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    await screen.findByRole("heading", { name: "Threads" });
    expect(window.location.pathname + window.location.search).toBe("/?unread=true");
    expect(FakePublicKeyCredential.parseRequestOptionsFromJSON).toHaveBeenCalledWith({
      challenge: "abc",
      rpId: "agention.test",
    });
    expect(api.callsTo("POST", "/auth/signin/finish")[0]?.body).toEqual({ credential: assertion });
  });

  it("says when a passkey request is cancelled, and when the server refuses it", async () => {
    const { credentials } = installPasskeys({});
    credentials.get.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
    api
      .on("GET", "/session", { body: signedOut })
      .on("POST", "/auth/signin/begin", { body: { options: { challenge: "abc" } } })
      .on(
        "POST",
        "/auth/signin/finish",
        failure("unauthenticated", "this passkey is not registered here"),
      );
    renderAt("/sign-in");
    const button = await screen.findByRole("button", { name: "Sign in with a passkey" });
    fireEvent.click(button);
    const cancelled = (await screen.findByRole("alert")).textContent;
    expect(api.callsTo("POST", "/auth/signin/finish")).toEqual([]);
    fireEvent.click(button);
    await waitFor(() => expect(api.callsTo("POST", "/auth/signin/finish")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("alert").textContent).not.toBe(cancelled));
    expect(window.location.pathname).toBe("/sign-in");
  });

  it("returns to sign-in, keeping the route, when a view finds the session ended", async () => {
    let sessionAnswers = 0;
    api
      .on("GET", "/session", () => ({ body: sessionAnswers++ === 0 ? signedIn : signedOut }))
      .on("GET", "/threads", failure("unauthenticated", "sign in first"));
    renderAt("/?unread=true");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(new URL(window.location.href).searchParams.get("next")).toBe("/?unread=true");
  });

  it("keeps the view and takes the new CSRF token when the session is still live", async () => {
    let sessionAnswers = 0;
    api
      .on("GET", "/session", () => ({
        body: { ...signedIn, csrf_token: sessionAnswers++ === 0 ? csrf : "csrf-token-2" },
      }))
      .on("GET", "/threads", {
        body: { threads: [threadSummary()], total: 1 },
      })
      .on("POST", "/reads", (call) =>
        call.headers["x-csrf-token"] === "csrf-token-2"
          ? { body: { threads: [] } }
          : failure("unauthenticated", "the CSRF token is missing or does not match the session"),
      );
    renderAt("/?unread=true");
    const markRead = await screen.findByRole("button", { name: "Mark all read" });
    fireEvent.click(markRead);
    await screen.findByRole("alert");
    await waitFor(() => expect(sessionAnswers).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await screen.findByRole("status");
    expect(window.location.search).toBe("?unread=true");
  });

  it("signs out to the sign-in page", async () => {
    api.on("POST", "/auth/signout", { body: signedOut });
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(window.location.pathname + window.location.search).toBe("/sign-in");
    expect(api.callsTo("POST", "/auth/signout")[0]?.headers["x-csrf-token"]).toBe(csrf);
  });

  it("says when signing out failed, and stays", async () => {
    api.on("POST", "/auth/signout", failure("internal", "internal error"));
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByRole("alert");
    expect(window.location.pathname).toBe("/");
  });
});

describe("the link page", () => {
  it("reads the token once, removes it, and registers a passkey with it", async () => {
    const created = {
      id: "cred",
      rawId: "cred",
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: { credProps: { rk: true } },
      response: { clientDataJSON: "e30", attestationObject: "AA", transports: ["internal"] },
    };
    const { FakePublicKeyCredential } = installPasskeys(created);
    // cspell:disable-next-line
    const token = "rAQvqtiqFoAr5N-YNH_Z1r6Vffdk57uEDLrvqgKxHro";
    api
      .on("GET", "/session", { body: { signed_in: false, operator_exists: false } })
      .on("POST", "/auth/link/begin", { body: { options: { challenge: "xyz" } } })
      .on("POST", "/auth/link/finish", { body: signedIn });
    renderAt(`/link#token=${token}`);
    await screen.findByLabelText("Passkey name");
    // The page removes the fragment in an effect that may run after it renders.
    await waitFor(() => expect(window.location.hash).toBe(""));
    fireEvent.change(screen.getByLabelText("Passkey name"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    await screen.findByRole("heading", { name: "Threads" });
    expect(api.callsTo("POST", "/auth/link/begin")[0]?.body).toEqual({ token, name: "Laptop" });
    expect(FakePublicKeyCredential.parseCreationOptionsFromJSON).toHaveBeenCalledWith({
      challenge: "xyz",
    });
    expect(api.callsTo("POST", "/auth/link/finish")[0]?.body).toEqual({ credential: created });
  });

  it("uses a newer link opened in the same tab, which changes only the fragment", async () => {
    installPasskeys({ id: "cred", rawId: "cred", type: "public-key", response: {} });
    let used = false;
    api
      .on("GET", "/session", { body: signedOut })
      .on("POST", "/auth/link/begin", (call) => {
        if ((call.body as { token: string }).token === "first") {
          used = true;
          return failure("unauthenticated", "the link is not valid; run passkey-link again");
        }
        return { body: { options: { challenge: "xyz" } } };
      })
      .on("POST", "/auth/link/finish", { body: signedIn });
    renderAt("/link#token=first");
    fireEvent.change(await screen.findByLabelText("Passkey name"), { target: { value: "Phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    await screen.findByRole("alert");
    expect(used).toBe(true);
    window.location.hash = "token=second";
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(window.location.hash).toBe("");
    // The skip link changes the fragment too, and leaves the pending token.
    await act(async () => {
      const skipped = new Promise((resolve) =>
        window.addEventListener("hashchange", resolve, { once: true }),
      );
      window.location.hash = "main";
      await skipped;
    });
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    await screen.findByRole("heading", { name: "Threads" });
    expect(api.callsTo("POST", "/auth/link/begin").map((call) => call.body)).toEqual([
      { token: "first", name: "Phone" },
      { token: "second", name: "Phone" },
    ]);
  });

  it("asks for the passkey's name before starting", async () => {
    installPasskeys({});
    api.on("GET", "/session", { body: signedOut });
    renderAt("/link#token=abc");
    fireEvent.change(await screen.findByLabelText("Passkey name"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    expect(screen.getByLabelText("Passkey name").getAttribute("aria-invalid")).toBe("true");
    expect(api.callsTo("POST", "/auth/link/begin")).toEqual([]);
  });

  it.each([true, false])(
    "warns that a link replaces every passkey only once the operator exists (%s)",
    async (operatorExists) => {
      installPasskeys({});
      api.on("GET", "/session", { body: { signed_in: false, operator_exists: operatorExists } });
      renderAt("/link#token=abc");
      await screen.findByLabelText("Passkey name");
      expect(document.querySelector(".notice.warning") !== null).toBe(operatorExists);
    },
  );

  it("says a link without a token cannot be used", async () => {
    installPasskeys({});
    api.on("GET", "/session", { body: signedOut });
    renderAt("/link");
    await screen.findByRole("heading", { name: "Register a passkey" });
    expect(screen.queryByLabelText("Passkey name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create a passkey" })).toBeNull();
  });

  it("refuses a credential the browser cannot turn into JSON", async () => {
    const { credentials } = installPasskeys({});
    credentials.create.mockResolvedValueOnce({} as never);
    api
      .on("GET", "/session", { body: signedOut })
      .on("POST", "/auth/link/begin", { body: { options: { challenge: "xyz" } } });
    renderAt("/link#token=abc");
    fireEvent.change(await screen.findByLabelText("Passkey name"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    await screen.findByRole("alert");
    expect(api.callsTo("POST", "/auth/link/finish")).toEqual([]);
  });
});

describe("the server's name", () => {
  // The name as the server writes it into the page's metadata.
  const name = `Work <&">`;
  beforeEach(() => {
    const meta = document.createElement("meta");
    meta.name = "application-name";
    meta.content = name;
    document.head.append(meta);
  });
  afterEach(() => {
    document.head.querySelector('meta[name="application-name"]')?.remove();
  });

  it.each([
    ["/", signedIn, "Threads"],
    ["/sign-in", signedOut, "Sign in"],
    ["/link", signedOut, "Register a passkey"],
  ] as const)(
    "brands the banner on %s and follows the page's own name in its title",
    async (path, session, page) => {
      installPasskeys({});
      api.on("GET", "/session", { body: session });
      renderAt(path);
      await screen.findByRole("heading", { level: 1, name: page });
      const banner = screen.getByRole("banner");
      expect(within(banner).getAllByRole("link")[0]?.textContent).toBe(name);
      await waitFor(() => expect(document.title).toBe(`${page} · ${name}`));
    },
  );
});

describe("the shell", () => {
  it("shows a page that does not exist as not found", async () => {
    renderAt("/nowhere");
    await screen.findByRole("heading", { name: "Not found" });
  });

  it("marks the current view in the navigation and names the page", async () => {
    renderAt("/?include_archived=true");
    await screen.findByRole("heading", { name: "Threads" });
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(within(views).getByRole("link", { name: "Threads" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      within(views).getByRole("link", { name: "Registrations" }).getAttribute("aria-current"),
    ).toBeNull();
    // The title is set in an effect, which can run after the heading shows.
    await waitFor(() => expect(document.title).toBe("Threads · Agention"));
  });

  it.each(["/", "/registrations", "/passkeys"])(
    "names %s on screen by its current tab, keeping its heading for assistive technology",
    async (path) => {
      api.on("GET", "/registrations", { body: { registrations: [] } });
      api.on("GET", "/passkeys", { body: { passkeys: [], recent: true } });
      renderAt(path);
      const heading = await screen.findByRole("heading", { level: 1 });
      const views = screen.getByRole("navigation", { name: "Views" });
      const current = within(views)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page");
      expect(current.map((link) => link.textContent)).toEqual([heading.textContent]);
      expect(heading.classList.contains("visually-hidden")).toBe(true);
    },
  );

  it("marks Threads as the current section on a thread page, which keeps its heading", async () => {
    const thread = threadSummary({ number: 7, unread: 0, last_seq: 1 });
    api.on("GET", "/s/builder/main/threads/7", { body: threadAnswer(thread, [message(1)]) });
    renderAt("/s/builder/main/threads/7");
    const heading = await screen.findByRole("heading", { level: 1, name: titled(thread.title) });
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(
      within(views)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("aria-current")]),
    ).toEqual([
      ["Threads", "true"],
      ["Registrations", null],
      ["Passkeys", null],
    ]);
    expect(heading.classList.contains("visually-hidden")).toBe(false);
  });

  it("shows the heading of a page with no tab", async () => {
    renderAt("/nowhere");
    const heading = await screen.findByRole("heading", { level: 1 });
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(
      within(views)
        .getAllByRole("link")
        .filter((link) => link.hasAttribute("aria-current")),
    ).toEqual([]);
    expect(heading.classList.contains("visually-hidden")).toBe(false);
  });

  it("moves focus to the new view's heading after a navigation", async () => {
    api.on("GET", "/registrations", { body: { registrations: [] } });
    renderAt("/");
    await screen.findByRole("heading", { name: "Threads" });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole("link", { name: "Registrations" }));
    const heading = await screen.findByRole("heading", { level: 1, name: "Registrations" });
    expect(document.activeElement).toBe(heading);
  });

  it("says when the server cannot be reached, and tries again", async () => {
    let reachable = false;
    api.on("GET", "/session", () =>
      reachable ? { body: signedIn } : { status: 502, text: "<h1>Bad gateway</h1>" },
    );
    renderAt("/");
    await screen.findByRole("alert");
    reachable = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Threads" });
  });

  it("reports an answer that is not the API's", async () => {
    api.on("GET", "/session", { text: "<!doctype html><title>Agention</title>" });
    renderAt("/");
    await screen.findByRole("alert");
  });
});
