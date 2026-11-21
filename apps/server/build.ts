import { bundle, type PackageNotice, readViteLicenses } from "@wayfarerlabs/agention-build";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

// The package ships the web UI's build in web/, which the server serves,
// so its notices cover the npm packages in both: those of the Vite build, and
// those of the diagram frame's script, which the web UI's build makes in a
// pass of its own. The package's build script runs the web build first.
const webBuild = "../web/dist";
const webLicenses = path.join(webBuild, ".vite", "license.json");
const frameNotices = path.join(webBuild, ".vite", "diagram-frame-notices.json");
if (
  !existsSync(path.join(webBuild, "index.html")) ||
  !existsSync(webLicenses) ||
  !existsSync(frameNotices)
) {
  throw new Error("the web UI is not built; run npm run -w apps/web build first");
}

await bundle("src/main.ts", "dist/agention.js", {
  alsoShips: {
    name: "the web UI in web/",
    packages: [
      ...readViteLicenses(webLicenses),
      ...(JSON.parse(readFileSync(frameNotices, "utf8")) as PackageNotice[]),
    ],
  },
});

rmSync("web", { recursive: true, force: true });
cpSync(webBuild, "web", {
  recursive: true,
  filter: (source) => path.basename(source) !== ".vite",
});
