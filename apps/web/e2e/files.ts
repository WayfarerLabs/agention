// cspell:ignore IHDR IDAT IEND
// What the attachment tests share: files to attach, made here rather than
// kept as fixtures, the operator signed in with an agent approved, and a way
// to leave an attached file without its contents, as a future purge would.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { PublicKey, UploadResult } from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-server-api/registration-code";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync, crc32 } from "node:zlib";
import { Agent } from "./agent.ts";
import { type Agention, expect, reportPolicyRefusals } from "./fixtures.ts";

export const threads = "/s/builder/main/threads";

// png draws an image of width by height, a band of color across it, as a
// PNG with no metadata.
export function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // 8 bits a channel, RGB, the standard compression, filter and no interlace.
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row.set([Math.round((255 * x) / width), 90 + Math.round((120 * y) / height), 200], 1 + x * 3);
    }
    return row;
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// pdf is a document of one blank page.
export function pdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>",
  ];
  let text = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = text.length;
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text, "latin1");
}

// webm records a second and a half in the page's browser, which has the
// encoders, as WebM: video of color changing on a canvas, or audio of a tone
// rising.
export async function webm(page: Page, kind: "video" | "audio" = "video"): Promise<Buffer> {
  const base64 = await page.evaluate(async (kind) => {
    let stream: MediaStream;
    let step: () => void;
    let stop = () => {};
    if (kind === "video") {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext("2d")!;
      stream = canvas.captureStream(25);
      let frame = 0;
      step = () => {
        context.fillStyle = `hsl(${(frame++ * 12) % 360} 70% 50%)`;
        context.fillRect(0, 0, 160, 90);
      };
    } else {
      const audio = new AudioContext();
      await audio.resume();
      const tone = audio.createOscillator();
      const output = audio.createMediaStreamDestination();
      tone.connect(output);
      tone.start();
      stream = output.stream;
      step = () => tone.frequency.setValueAtTime(tone.frequency.value + 20, audio.currentTime);
      stop = () => void audio.close();
    }
    const recorder = new MediaRecorder(stream, { mimeType: `${kind}/webm` });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const timer = setInterval(step, 40);
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.stop();
    await stopped;
    clearInterval(timer);
    stop();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = "";
    bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
    return btoa(binary);
  }, kind);
  return Buffer.from(base64, "base64");
}

// signIn registers the operator's first passkey on a virtual authenticator,
// and approves an agent, builder/main, which the tests write as.
export async function signIn(
  browser: Browser,
  server: Agention,
): Promise<{ context: BrowserContext; page: Page; agent: Agent }> {
  const context = await browser.newContext({
    baseURL: server.origin,
    viewport: { width: 1280, height: 800 },
  });
  await reportPolicyRefusals(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(server.passkeyLink());
  await page.getByLabel("Passkey name").fill("Laptop");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  const agent = new Agent(server);
  await agent.send("POST", "/registrations", { agent: "builder", session: "main" });
  await page.getByRole("link", { name: "Sessions" }).click();
  const code = registrationCode(agent.publicKey as PublicKey);
  await page
    .getByRole("article", { name: `Registration ${code}` })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(page.getByRole("button", { name: /^Agent builder/ })).toBeVisible();
  return { context, page, agent };
}

// upload uploads bytes as the agent, under a name and a declared type, and
// returns the reference a message names it by.
export async function upload(
  agent: Agent,
  name: string,
  bytes: Buffer,
  type: string,
): Promise<string> {
  const answer = await agent.upload<UploadResult>(
    `/s/builder/main/uploads?name=${encodeURIComponent(name)}`,
    bytes,
    type,
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.upload;
}

// removeContents deletes an attached file's bytes from the server's database
// while it runs, as a future purge would, lifting for that moment the rule
// that keeps them.
export function removeContents(server: Agention, ref: string): void {
  const db = new DatabaseSync(path.join(server.data, "agention.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'file_chunks_kept'")
      .get() as { sql: string };
    db.exec("BEGIN IMMEDIATE");
    db.exec("DROP TRIGGER file_chunks_kept");
    db.prepare("DELETE FROM file_chunks WHERE file_id = (SELECT id FROM files WHERE ref = ?)").run(
      ref,
    );
    db.exec(sql);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
