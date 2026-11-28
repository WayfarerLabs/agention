// What every component test starts from.
import { configure } from "@testing-library/react";
import { beforeEach } from "vitest";
import { forgetHeldNotifications } from "./device.ts";

// Under machine load a component can take longer than Testing Library's
// default second to show what a test finds; a find still returns the moment
// its element shows.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no media queries. Here none matches, as on a desktop with a mouse
// in the light scheme, unless a test stubs matchMedia with what it needs.
window.matchMedia = (query: string) =>
  ({
    media: query,
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }) as unknown as MediaQueryList;

// Each test starts with nothing kept in the browser's storage.
beforeEach(() => {
  window.localStorage.clear();
  forgetHeldNotifications();
});
