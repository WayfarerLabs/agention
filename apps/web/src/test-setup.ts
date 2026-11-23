// What every component test starts from.
import { beforeEach } from "vitest";

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
});
