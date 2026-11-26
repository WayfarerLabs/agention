import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ownHeaders } from "./own-headers.ts";

// The web UI is the Vite build of apps/web, which the server package carries
// in its web/ directory. A path that names a file of the build gets that file;
// any other path outside assets/ gets the UI's index page, whose router shows
// the route.

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

// The web app manifest's path in the build, which the index page links to.
// The server serves it with its own name as the installed app's, so two
// servers a device installs are told apart as their pages are.
const webAppManifestPath = "/manifest.webmanifest";

// namedManifest sets the server's name as the manifest's name and short name.
const namedManifest = (file: string, name: string) =>
  JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), name, short_name: name });

// The paths at which the build would serve the index page's file as it is on
// disk: the root, and the file's own name in any case, since a
// case-insensitive file system serves it under every one.
const isIndexFile = (requested: string) =>
  requested === "/" || requested.toLowerCase() === "/index.html";

// The build's files under assets/ are named for their content, so a browser
// keeps one for good.
const assetCaching = "public, max-age=31536000, immutable";

// serveAssets adds the route that serves the build's files under assets/,
// each as the Brotli copy the package's build wrote beside it (build.ts) when
// the browser accepts that, or else as it is. A path that names no file there
// is not_found, since no route of the UI is under assets/, and only the file
// itself, whole or a range of it, is cached.
function serveAssets(app: Hono, root: string): void {
  const serveFile = serveStatic({ root, precompressed: true });
  app.get("/assets/*", async (c) => {
    // serveStatic returns what next returns when it finds no file, so with a
    // next that returns nothing, a miss comes back undefined.
    const response = await serveFile(c, () => Promise.resolve());
    if (response === undefined) {
      return c.notFound();
    }
    if (response.ok) {
      response.headers.set("Cache-Control", assetCaching);
      ownHeaders(c.req.raw, ["cache-control"]);
    }
    // serveStatic varies only the Brotli copy. Varying the file as it is too
    // saves bytes behind a shared cache, which would otherwise answer every
    // browser with it.
    response.headers.set("Vary", "Accept-Encoding");
    return response;
  });
}

// serveWebUi adds the GET routes that serve the build in root, or the
// placeholder page when root holds no build. The index page and the web app
// manifest are prepared once, as the server starts, carrying the server's
// name, and their files are never served as they are. The app's own routes,
// the API included, must be added first.
export function serveWebUi(app: Hono, root: string | undefined, name: string): void {
  if (root === undefined || !existsSync(path.join(root, "index.html"))) {
    app.get("/*", (c) => c.html(placeholderPage));
    return;
  }
  const page = namedPage(readFileSync(path.join(root, "index.html"), "utf8"), name);
  const serveIndex = (c: Context) => c.html(page);
  app.get("/*", (c, next) => (isIndexFile(c.req.path) ? serveIndex(c) : next()));
  serveAssets(app, root);
  // A build without the manifest serves none, so its path serves as any other.
  const manifestFile = path.join(root, webAppManifestPath);
  if (existsSync(manifestFile)) {
    const manifest = namedManifest(manifestFile, name);
    // Matched in any case, as the index page's file is.
    app.get("/*", (c, next) =>
      c.req.path.toLowerCase() === webAppManifestPath
        ? c.body(manifest, 200, { "Content-Type": "application/manifest+json" })
        : next(),
    );
  }
  app.get("/*", serveStatic({ root }));
  app.get("/*", serveIndex);
}
