import { namePattern } from "@wayfarerlabs/agention-api/name-pattern";

// The UI's routes. The server answers every path that is not an API route, a
// file of the build, or under assets/ with the UI's page, so each route is
// also a URL that can be opened directly. This module holds no React, no DOM
// and no schema, so the service worker shares it: it checks a notification's
// thread by its route, and opens it only in a window showing a route of the
// UI.

export type Route =
  | { name: "threads" }
  | { name: "thread"; agent: string; session: string; thread: number }
  | { name: "sessions" }
  | { name: "session"; agent: string; session: string }
  | { name: "registration"; id: number }
  | { name: "settings" }
  | { name: "settings-section"; section: string }
  | { name: "sign-in" }
  | { name: "link" }
  // A page that has moved, which the shell replaces with where it is now.
  | { name: "moved"; to: string }
  | { name: "not-found" };

const threadRoute = /^\/s\/([^/]+)\/([^/]+)\/threads\/([1-9]\d{0,15})$/;
// A session, on the Sessions tab: /s/<agent>/<session> is the API's.
const sessionRoute = /^\/sessions\/([^/]+)\/([^/]+)$/;
// A registration waiting for approval, on the Sessions tab, by its number.
const registrationRoute = /^\/registrations\/([1-9]\d{0,15})$/;
// A section of Settings, by its slug, which the Settings view looks up.
const settingsSectionRoute = /^\/settings\/([^/]+)$/;

export function matchRoute(pathname: string): Route {
  switch (pathname) {
    case "/":
      return { name: "threads" };
    // The sessions view, which agents' registrations still name by the path
    // of the page it took the place of.
    case "/sessions":
    case "/registrations":
      return { name: "sessions" };
    case "/settings":
      return { name: "settings" };
    // The passkeys' page of old, now Settings' passkeys section.
    case "/passkeys":
      return { name: "moved", to: "/settings/passkeys" };
    case "/sign-in":
      return { name: "sign-in" };
    case "/link":
      return { name: "link" };
  }
  const [, section] = settingsSectionRoute.exec(pathname) ?? [];
  if (section !== undefined) {
    return { name: "settings-section", section };
  }
  const [, numbered] = registrationRoute.exec(pathname) ?? [];
  if (numbered !== undefined && Number.isSafeInteger(Number(numbered))) {
    return { name: "registration", id: Number(numbered) };
  }
  const [, ofAgent = "", named = ""] = sessionRoute.exec(pathname) ?? [];
  if (namePattern.test(ofAgent) && namePattern.test(named)) {
    return { name: "session", agent: ofAgent, session: named };
  }
  const [, agent = "", session = "", thread = ""] = threadRoute.exec(pathname) ?? [];
  const number = Number(thread);
  return namePattern.test(agent) && namePattern.test(session) && Number.isSafeInteger(number)
    ? { name: "thread", agent, session, thread: number }
    : { name: "not-found" };
}

// threadHref is a thread's route, built from its identifiers alone.
export function threadHref(agent: string, session: string, thread: number): string {
  return `/s/${agent}/${session}/threads/${thread}`;
}
