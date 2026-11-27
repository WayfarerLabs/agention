import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ownHeaders } from "./own-headers.ts";

// The diagram frame: a page the web UI embeds in a sandboxed frame, with
// scripts only, whose one script draws Mermaid diagrams from message text and
// answers with their SVG. Its response carries a policy of its own, which
// sandboxes it even when it is opened on its own, lets it load nothing but
// its script, and lets only the server's own pages frame it. Its route
// declares that policy and the framing its own, so the security headers
// middleware leaves them in place. The script is a file of the web UI's build
// like any other, which web-ui.ts serves.

export const diagramFramePath = "/diagram-frame";

// The file in the web UI's build naming the frame's script, which the web
// UI's build writes beside its index page.
const manifestFile = "diagram-frame.json";

// The script's path, as the build names it, for its content.
const scriptPath = /^assets\/diagram-frame-[A-Za-z0-9]+\.js$/;

// diagramFramePolicy is the frame's content security policy. The script, and
// the pages that may frame it, are named by the server's origin, so the
// policy does not depend on how a browser reads 'self' in a frame whose
// origin is opaque. Mermaid styles its SVG inline and
// measures text with those styles, which only the frame allows: it reaches
// neither the app nor the network.
export function diagramFramePolicy(origin: string, script: string): string {
  return (
    `sandbox allow-scripts; default-src 'none'; script-src ${origin}/${script}; ` +
    "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; " +
    `frame-ancestors ${origin}`
  );
}

function framePage(script: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Diagram</title>
  </head>
  <body>
    <script src="/${script}"></script>
  </body>
</html>
`;
}

// readScript returns the frame's script path from the build's manifest, or
// undefined when the build has none; a manifest that names no script of the
// build stops the server from starting.
function readScript(root: string): string | undefined {
  const manifest = path.join(root, manifestFile);
  if (!existsSync(manifest)) {
    return undefined;
  }
  const { script } = JSON.parse(readFileSync(manifest, "utf8")) as { script?: unknown };
  if (typeof script !== "string" || !scriptPath.test(script)) {
    throw new Error(`${manifest} names no diagram frame script`);
  }
  if (!existsSync(path.join(root, script))) {
    throw new Error(`${manifest} names ${script}, which the build does not hold`);
  }
  return script;
}

// serveDiagramFrame adds the frame's page, for the script the web UI's build
// in root holds, before the routes that serve the build. A build without the
// frame adds none, so its path serves as any other.
export function serveDiagramFrame(app: Hono, root: string | undefined, origin: string): void {
  const script = root === undefined ? undefined : readScript(root);
  if (script === undefined) {
    return;
  }
  const page = framePage(script);
  const policy = diagramFramePolicy(origin, script);
  app.get(diagramFramePath, (c) => {
    c.header("Content-Security-Policy", policy);
    c.header("X-Frame-Options", "SAMEORIGIN");
    ownHeaders(c.req.raw, ["content-security-policy", "x-frame-options"]);
    return c.html(page);
  });
}
