// What every component test starts from.

// jsdom has no media queries. Here none matches, as on a desktop with a mouse
// in the light scheme, unless a test stubs matchMedia with what it needs.
window.matchMedia = (query: string) =>
  ({
    media: query,
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }) as unknown as MediaQueryList;
