import { bundleScript } from "@wayfarerlabs/agention-build";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// The service worker's script, built in a pass of its own after the web UI's
// Vite build, into the same dist/, as the diagram frame's is. A browser keeps
// one registration per script address, so the script is dist/service-worker.js,
// the same name in every release, rather than one named for its content; at
// the root, its scope is the whole web UI. dist/.vite/service-worker-notices.json
// holds the license notices of what it includes, which the server package
// ships with the web UI's.
const dist = "dist";
if (!existsSync(path.join(dist, "index.html"))) {
  throw new Error("the web UI is not built; run vite build first");
}

const { packages } = await bundleScript(
  "src/service-worker/service-worker.ts",
  dist,
  "service-worker",
  "dist/THIRD-PARTY-NOTICES.txt in the @wayfarerlabs/agention npm package",
  { fixedName: true },
);
mkdirSync(path.join(dist, ".vite"), { recursive: true });
writeFileSync(path.join(dist, ".vite", "service-worker-notices.json"), JSON.stringify(packages));
