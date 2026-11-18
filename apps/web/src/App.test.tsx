import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

// A smoke test that proves the web test pipeline runs: Vitest compiles TSX
// through the Vite configuration and React renders a component.
describe("web test pipeline", () => {
  it("compiles and renders the App component", () => {
    expect(renderToStaticMarkup(<App />)).toMatch(/^<main>.*<\/main>$/s);
  });
});
