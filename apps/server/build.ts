import { bundle, type PackageNotice, readViteLicenses } from "@wayfarerlabs/agention-build";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";

// The package ships the web UI's build in web/, which the server serves,
// so its notices cover the third-party packages in both: those of the Vite build,
// those of the diagram frame's script and of the service worker's, which the
// web UI's build makes in passes of their own, and the Material Symbols the
// web UI's icons copy
// (apps/web/src/icons.tsx). The package's build script runs the web build
// first.
const webBuild = "../web/dist";
const webLicenses = path.join(webBuild, ".vite", "license.json");
const passNotices = ["diagram-frame-notices.json", "service-worker-notices.json"].map((file) =>
  path.join(webBuild, ".vite", file),
);
if (
  !existsSync(path.join(webBuild, "index.html")) ||
  !existsSync(webLicenses) ||
  !passNotices.every((file) => existsSync(file))
) {
  throw new Error("the web UI is not built; run npm run -w apps/web build first");
}

await bundle("src/main.ts", "dist/agention.js", {
  alsoShips: {
    name: "the web UI in web/",
    packages: [
      ...readViteLicenses(webLicenses),
      ...passNotices.flatMap((file) => JSON.parse(readFileSync(file, "utf8")) as PackageNotice[]),
      {
        name: "Material Symbols",
        version: "google/material-design-icons@10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7",
        license: "Apache-2.0",
        texts: [readFileSync("../web/third-party/material-symbols/LICENSE", "utf8").trim()],
      },
    ],
  },
});

rmSync("web", { recursive: true, force: true });
cpSync(webBuild, "web", {
  recursive: true,
  filter: (source) => path.basename(source) !== ".vite",
});

// The server has browsers keep every file under assets/ for good, so each must
// be named for its content, as Vite and the frame's pass name theirs. The check
// is of the name's form alone: eight characters that are no hash pass it too.
//
// The server also serves the Brotli copy written beside each, so nothing is
// compressed as it runs. Brotli alone is enough: browsers take it only over
// HTTPS, and the server's origin is always https (canonicalOrigin in
// packages/api); a client that takes none gets the file as it is. Brotli's
// default quality is its highest.
const assets = path.join("web", "assets");
for (const name of readdirSync(assets)) {
  if (!/-[\w-]{8}\.\w+$/.test(name)) {
    throw new Error(`${name}, in the web UI's assets/, does not end in a content hash`);
  }
  const file = path.join(assets, name);
  writeFileSync(`${file}.br`, brotliCompressSync(readFileSync(file)));
}
