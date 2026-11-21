import { bundleScript } from "@wayfarerlabs/agention-build";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// The diagram frame's script, built in a pass of its own after the web UI's
// Vite build, into the same dist/. The server serves it in a sandboxed frame,
// whose origin is opaque, so it is one classic script with every dynamic
// import inlined: a module, or a chunk loaded on demand, would be a
// cross-origin load there, and fail. dist/diagram-frame.json names the script
// for the server, and dist/.vite/diagram-frame-notices.json holds the license
// notices of what it includes, which the server package ships with the web
// UI's. The script names that package's notices in the comment it opens with.
const dist = "dist";
if (!existsSync(path.join(dist, "index.html"))) {
  throw new Error("the web UI is not built; run vite build first");
}

const { file, packages } = await bundleScript(
  "src/diagram-frame/frame.ts",
  dist,
  "diagram-frame",
  "dist/THIRD-PARTY-NOTICES.txt in the @wayfarerlabs/agention npm package",
);
writeFileSync(path.join(dist, "diagram-frame.json"), `${JSON.stringify({ script: file })}\n`);
mkdirSync(path.join(dist, ".vite"), { recursive: true });
writeFileSync(path.join(dist, ".vite", "diagram-frame-notices.json"), JSON.stringify(packages));
