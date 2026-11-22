import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// The web UI is the Vite build of apps/web, which the server package carries
// in its web/ directory. A path that names a file of the build gets that file;
// any other path gets the UI's index page, whose router shows the route.

// The page served in place of the UI when the server was built without it.
// It carries no script or style, so the content security policy holds.
const placeholderPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agention</title>
  </head>
  <body>
    <h1>Agention</h1>
    <p>This server was built without its web UI. The API works; build the server package with
    its web UI to use Agention from a browser.</p>
  </body>
</html>
`;

// The slots of the index page that carry the server's name, each matching the
// text before the name and after it: its title, and the metadata naming it as
// an application and on a phone's home screen, from which the UI reads the
// name. The web UI's source page holds each slot once.
export const nameSlots = [
  /(<title>)[^<]*(<\/title>)/g,
  /(<meta name="application-name" content=")[^"]*(")/g,
  /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/g,
];

const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// escapeHtml writes text so HTML reads it back as it is, in an element's
// content or a quoted attribute.
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (each) => htmlEscapes[each] ?? "");

// namedPage writes the server's name, escaped, into each slot of the index
// page.
function namedPage(page: string, name: string): string {
  const escaped = escapeHtml(name);
  return nameSlots.reduce(
    (named, slot) =>
      named.replace(slot, (_, before: string, after: string) => before + escaped + after),
    page,
  );
}

// The paths at which the build would serve the index page's file as it is on
// disk: the root, and the file's own name in any case, since a
// case-insensitive file system serves it under every one.
const isIndexFile = (requested: string) =>
  requested === "/" || requested.toLowerCase() === "/index.html";

// serveWebUi adds the GET routes that serve the build in root, or the
// placeholder page when root holds no build. The index page is prepared once,
// as the server starts, carrying the server's name, and its file is never
// served as it is. The app's own routes, the API included, must be added
// first.
export function serveWebUi(app: Hono, root: string | undefined, name: string): void {
  if (root === undefined || !existsSync(path.join(root, "index.html"))) {
    app.get("/*", (c) => c.html(placeholderPage));
    return;
  }
  const page = namedPage(readFileSync(path.join(root, "index.html"), "utf8"), name);
  const serveIndex = (c: Context) => c.html(page);
  app.get("/*", (c, next) => (isIndexFile(c.req.path) ? serveIndex(c) : next()));
  app.get("/*", serveStatic({ root }));
  app.get("/*", serveIndex);
}
