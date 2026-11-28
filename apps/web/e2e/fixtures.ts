// The browser tests' servers: the built Agention server, serving its built web
// UI over TLS at https://agention.test:<port>, and a Chromium that trusts it.
// A second server on another port of the same host starts for the tests that
// ask for it, presenting the same certificate, as servers sharing a host may,
// and so do servers of the diagram, voice, API key, attachment, selection,
// session link, saved views, notifications, and settled threads tests' own.
//
// Passkeys need a secure context whose certificate the browser accepts and a
// relying party that is a domain name; the server refuses an IP address as
// its origin. So Chromium resolves agention.test to the loopback address
// (--host-resolver-rules), and trusts the test certificate made for that name
// by its public key (--ignore-certificate-errors-spki-list). Trusting that one
// key makes the page a real secure context, where ignoring certificate errors
// altogether would only bypass them.
import {
  test as base,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from "@playwright/test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The server's own test certificate maker, so both suites make certificates
// one way.
import { testCertificate } from "../../server/src/http/test-certificate.ts";
import type { AgentServer } from "./agent.ts";

export const hostName = "agention.test";

// The server's name, holding characters HTML would read as markup unless the
// server escapes them.
export const serverName = `Work <&"> co`;

// The second server's name.
export const secondServerName = "Personal";

// The name of the server the diagram tests start for themselves.
export const diagramsServerName = "Diagrams";

// The name of the server the voice tests start for themselves.
export const voiceServerName = "Voice";

// The name of the server the API key tests start for themselves.
export const keysServerName = "Keys";
// The name of the server the attachment tests start for themselves.
export const filesServerName = "Files";
// The name of the server the pull request and branch tests start for
// themselves.
export const linksServerName = "Links";
// The name of the server the selection tests start for themselves.
export const selectionServerName = "Selection";
// The name of the server the session link tests start for themselves.
export const sessionLinksServerName = "Session links";
// The name of the server the saved views tests start for themselves.
export const savedViewsServerName = "Saved views";
// The name of the server the notifications tests start for themselves, which
// also serves the API's documentation.
export const notificationsServerName = "Notifications";

// The name of the server the settled threads tests start for themselves.
export const settledServerName = "Settled";

// The name of the server the README's screenshots are taken of.
export const screenshotsServerName = "Agention";

// The server bundle the server package's build writes, beside the web UI it
// ships in web/.
const serverBundle = fileURLToPath(new URL("../../server/dist/agention.js", import.meta.url));

// How long a server may take to start serving: less than a fixture may take,
// so a start that hangs is ended here.
const startLimit = 30_000;

export interface Agention extends AgentServer {
  // passkeyLink runs agention passkey-link and returns the link it prints.
  passkeyLink(): string;
  // The server's data directory, which holds its database.
  data: string;
}

// The certificate every server of a worker presents for the host, and the
// base64 SHA-256 of its public key, which Chromium trusts.
interface HostCertificate {
  cert: string;
  key: string;
  spki: string;
}

function hostCertificate(): HostCertificate {
  const certificate = testCertificate(hostName);
  const spki = createHash("sha256")
    .update(new X509Certificate(certificate.cert).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  return { ...certificate, spki };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function startServer(
  name: string,
  certificate: HostCertificate,
  extraArgs: readonly string[] = [],
): Promise<{ agention: Agention; stop(): Promise<void> }> {
  if (!existsSync(serverBundle)) {
    throw new Error("the server is not built; run npm run -w apps/server build first");
  }
  const root = mkdtempSync(path.join(tmpdir(), "agention-browser-"));
  const data = path.join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  const certFile = path.join(root, "cert.pem");
  const keyFile = path.join(root, "key.pem");
  writeFileSync(certFile, certificate.cert);
  writeFileSync(keyFile, certificate.key, { mode: 0o600 });

  const port = await freePort();
  const origin = `https://${hostName}:${port}`;
  const server: ChildProcess = spawn(
    process.execPath,
    [
      serverBundle,
      "serve",
      "--data",
      data,
      "--origin",
      origin,
      "--listen",
      `127.0.0.1:${port}`,
      "--tls-cert",
      certFile,
      "--tls-key",
      keyFile,
      "--name",
      name,
      ...extraArgs,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`agention serve did not start within ${startLimit} ms:\n${log}`)),
        startLimit,
      );
      server.stderr?.setEncoding("utf8");
      server.stderr?.on("data", (chunk: string) => {
        log += chunk;
        if (log.includes("agention: serving")) {
          resolve();
        }
      });
      server.on("error", reject);
      server.on("exit", (code) => reject(new Error(`agention serve exited with ${code}:\n${log}`)));
    });
  } catch (error) {
    // A server that never served would outlive the worker, holding its port.
    server.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const agention: Agention = {
    origin,
    port,
    certificate: certificate.cert,
    data,
    passkeyLink: () =>
      execFileSync(
        process.execPath,
        [serverBundle, "passkey-link", "--data", data, "--origin", origin],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim(),
  };
  const stop = async () => {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
    rmSync(root, { recursive: true, force: true });
  };
  return { agention, stop };
}

// serving starts a server under a name, with any other arguments of agention
// serve, for a worker's tests, and stops it after them.
const serving =
  (name: string, extraArgs: readonly string[] = []) =>
  async (
    { certificate }: { certificate: HostCertificate },
    use: (agention: Agention) => Promise<void>,
  ) => {
    const { agention, stop } = await startServer(name, certificate, extraArgs);
    await use(agention);
    await stop();
  };

export const test = base.extend<
  object,
  {
    certificate: HostCertificate;
    agention: Agention;
    secondServer: Agention;
    diagramsServer: Agention;
    voiceServer: Agention;
    keysServer: Agention;
    filesServer: Agention;
    linksServer: Agention;
    selectionServer: Agention;
    sessionLinksServer: Agention;
    savedViewsServer: Agention;
    notificationsServer: Agention;
    settledServer: Agention;
    screenshotsServer: Agention;
  }
>({
  certificate: [
    async ({}, use) => {
      await use(hostCertificate());
    },
    { scope: "worker" },
  ],
  agention: [serving(serverName), { scope: "worker" }],
  secondServer: [serving(secondServerName), { scope: "worker" }],
  diagramsServer: [serving(diagramsServerName), { scope: "worker" }],
  voiceServer: [serving(voiceServerName), { scope: "worker" }],
  keysServer: [serving(keysServerName), { scope: "worker" }],
  filesServer: [serving(filesServerName), { scope: "worker" }],
  linksServer: [serving(linksServerName), { scope: "worker" }],
  selectionServer: [serving(selectionServerName), { scope: "worker" }],
  sessionLinksServer: [serving(sessionLinksServerName), { scope: "worker" }],
  savedViewsServer: [serving(savedViewsServerName), { scope: "worker" }],
  notificationsServer: [serving(notificationsServerName, ["--api-docs"]), { scope: "worker" }],
  settledServer: [serving(settledServerName), { scope: "worker" }],
  screenshotsServer: [serving(screenshotsServerName), { scope: "worker" }],
  launchOptions: [
    async ({ certificate }, use) => {
      await use({
        args: [
          `--host-resolver-rules=MAP ${hostName} 127.0.0.1`,
          `--ignore-certificate-errors-spki-list=${certificate.spki}`,
          // A microphone that plays a tone, granted without asking, for the
          // voice tests' dictation.
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
        ],
      });
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";

// reportPolicyRefusals has every page of a context, and each frame within
// one, log each content security policy refusal as a console error, which the
// tests collect as a problem. A refusal the page catches, as Zod catches its
// probe for eval, otherwise reaches no console.
export async function reportPolicyRefusals(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(
        `content security policy refused ${event.violatedDirective} from ${event.sourceFile}`,
      );
    });
  });
}

// Below the web UI's phone breakpoint (40rem, styles.css).
const phoneWidth = 640;

// Each page's session with Chromium for touch emulation, kept open since
// closing it ends the emulation.
const devtools = new WeakMap<Page, CDPSession>();

// Sizes the window as a test's device: below a phone's width the main pointer
// is a touch screen, as on a phone, so the page takes the sizes it gives a
// fingertip; at a wider one it is the mouse Playwright's Chromium has, which
// takes the denser sizes (styles.css, pointer: fine), unless touch says
// otherwise, as for a tablet.
export async function resize(
  page: Page,
  size: { width: number; height: number },
  touch = size.width < phoneWidth,
): Promise<void> {
  let session = devtools.get(page);
  if (session === undefined) {
    session = await page.context().newCDPSession(page);
    devtools.set(page, session);
  }
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: 1 });
  await page.setViewportSize(size);
  // The page may see the new size late under load, and its media listeners,
  // which lay it out by width and pointer, run only at the next frame after;
  // measure nothing before they do.
  await page.waitForFunction((width) => window.innerWidth === width, size.width);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
}

// withinTheScreen checks that what is shown stands whole across the screen's
// width, with nothing on the page to scroll sideways.
export async function withinTheScreen(shown: Locator): Promise<void> {
  const page = shown.page();
  const width = page.viewportSize()?.width ?? 0;
  const box = await shown.boundingBox();
  base.expect(box).not.toBeNull();
  base.expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  base.expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
  base
    .expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

// approve approves as proposed the registration waiting with a code: from
// its row on the Sessions tab, on its page, which then goes on to the
// session it granted.
export async function approve(page: Page, code: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: /^Sessions/ })
    .click();
  const row = page.getByRole("link", { name: new RegExp(`^Registration ${code} for `) });
  await row.click();
  await page
    .getByRole("article", { name: `Registration ${code}` })
    .getByRole("button", { name: "Approve" })
    .click();
  await base.expect(row).toHaveCount(0);
}
