// The web UI as an installable app, as Chromium reads it: its own manifest
// parser finds the page's manifest whole, named for the server, opening
// standalone at the root and scoped to it, with icons that decode at the
// sizes they declare, at 192 and 512 pixels among those for any use, as
// Chrome's install criteria ask (https://web.dev/articles/install-criteria).
// The fixture's server is a secure context, as the criteria also ask.
// Chromium's installability check itself, Page.getInstallabilityErrors, is
// the full browser's: the headless shell answers it with no errors whatever
// the page serves, a missing manifest included, so a test on it would prove
// nothing.
import { expect, serverName, test } from "./fixtures.ts";

test("Chromium reads the web UI as an installable app named for its server", async ({
  browser,
  agention,
}) => {
  const context = await browser.newContext({ baseURL: agention.origin });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto("/");

  const root = `${agention.origin}/`;
  const { url, errors, data, manifest } = await cdp.send("Page.getAppManifest", {});
  expect([url, errors]).toEqual([`${root}manifest.webmanifest`, []]);
  expect(manifest).toMatchObject({
    name: serverName,
    display: "kStandalone",
    id: root,
    startUrl: root,
    scope: root,
    preferRelatedApplications: false,
  });

  // Chromium's parse leaves out each icon's purpose, which its source states.
  const declared = (JSON.parse(data ?? "{}") as { icons?: { sizes?: string; purpose?: string }[] })
    .icons;
  const forAnyUse = (declared ?? []).filter((icon) => (icon.purpose ?? "any").includes("any"));
  expect(forAnyUse.map((icon) => icon.sizes)).toEqual(
    expect.arrayContaining(["192x192", "512x512"]),
  );

  const icons = manifest.icons ?? [];
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons) {
    expect(icon.type).toBe("image/png");
    const decoded = await page.evaluate(async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }, icon.url);
    expect([icon.url, decoded]).toEqual([icon.url, icon.sizes]);
  }
  await context.close();
});
