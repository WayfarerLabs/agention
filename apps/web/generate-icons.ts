import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The app icons the web app manifest names, drawn from their SVG sources in
// Chromium's headless shell, the browser tests' own, into public/icons/,
// which the build copies as it is. scripts/generate-icons.sh runs this; run
// it when a source changes and commit the images with it. The favicon is the
// icon a browser shows as it is, with its rounded corners; the maskable
// source fills its square, for launchers that cut their own shape from it,
// and keeps its mark inside the middle circle every such shape leaves whole.
const web = import.meta.dirname;
const icons = [
  { source: "public/favicon.svg", sizes: [192, 512], prefix: "" },
  { source: "icons/maskable.svg", sizes: [512], prefix: "maskable-" },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { source, sizes, prefix } of icons) {
    const svg = readFileSync(path.join(web, source)).toString("base64");
    for (const size of sizes) {
      await page.setViewportSize({ width: size, height: size });
      await page.goto(`data:image/svg+xml;base64,${svg}`);
      const file = path.join(web, "public", "icons", `${prefix}${size}.png`);
      await page.screenshot({ path: file, omitBackground: true });
      console.log(path.relative(web, file));
    }
  }
} finally {
  await browser.close();
}
