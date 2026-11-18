import { bundle, readViteLicenses } from "@wayfarerlabs/agention-build";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

// The package ships the web UI's Vite build in web/, which the server serves,
// so its notices cover the npm packages in both. The package's build script
// runs the web build first.
const webBuild = "../web/dist";
const webLicenses = path.join(webBuild, ".vite", "license.json");
if (!existsSync(path.join(webBuild, "index.html")) || !existsSync(webLicenses)) {
  throw new Error("the web UI is not built; run npm run -w apps/web build first");
}

await bundle("src/main.ts", "dist/agention.js", {
  alsoShips: { name: "the web UI in web/", packages: readViteLicenses(webLicenses) },
});

rmSync("web", { recursive: true, force: true });
cpSync(webBuild, "web", {
  recursive: true,
  filter: (source) => path.basename(source) !== ".vite",
});
