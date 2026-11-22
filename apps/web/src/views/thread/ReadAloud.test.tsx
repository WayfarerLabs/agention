import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerTo, ask, installSpeech, message, operatorMessage } from "../../test-support.tsx";
import { wordsOf } from "../../voice/speech.ts";
import { option, optionNames, optionsButton, ThreadPageTest } from "./thread-test-support.tsx";

describe("the words a message reads aloud as", () => {
  it("say its text block by block, a sentence at a time, with code and diagrams named", () => {
    const text = [
      "# Plan",
      "",
      "Ship it today. Then rest.",
      "",
      "- First step",
      "- Second **step**",
      "",
      "```sh",
      "npm run build",
      "```",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "",
      "| Check | Result |",
      "| --- | --- |",
      "| Lint | ok |",
    ].join("\n");
    const words = wordsOf(message(1, { text, detail: "More in detail." }));
    // The message's own words, block by block and a sentence at a time, then
    // a sentence each naming the code block and the diagram, which are not
    // read, a sentence for each table row, and the detail.
    expect(words).toHaveLength(10);
    expect(words.slice(0, 5)).toEqual([
      "Plan",
      "Ship it today.",
      "Then rest.",
      "First step",
      "Second step",
    ]);
    expect(words.join(" ")).not.toMatch(/npm run build|graph TD/);
    expect(words[5]).not.toBe(words[6]);
    expect(words[7]).toMatch(/Check.*Result/);
    expect(words[8]).toMatch(/Lint.*ok/);
    expect(words[9]).toBe("More in detail.");
  });

  it("say each ask with its options, and each answer with what it chose", () => {
    const asked = wordsOf(message(1, { asks: [ask()] })).join(" ");
    expect(asked).toMatch(/Which database\?.*SQLite.*Postgres/);
    const answered = wordsOf(
      operatorMessage(2, {
        answers: [
          answerTo({ picks: [0], labels: ["SQLite"], text: "For now" }),
          answerTo({ ask: 2, declined: true }),
        ],
      }),
    );
    expect(answered.join(" ")).toMatch(/SQLite.*For now/);
    // A decline is said too, in a sentence of its own.
    expect(answered.length).toBeGreaterThan(
      wordsOf(
        operatorMessage(2, {
          answers: [answerTo({ picks: [0], labels: ["SQLite"], text: "For now" })],
        }),
      ).length,
    );
  });
});

describe("reading a message aloud", () => {
  let page: ThreadPageTest;

  beforeEach(() => {
    page = new ThreadPageTest();
  });

  afterEach(() => {
    cleanup();
    expect(page.api.unhandled).toEqual([]);
  });

  it("is offered only where the browser can speak", async () => {
    await page.openWith([message(1, { text: "Hello." })]);
    expect(optionNames(1)).not.toContain("Read aloud");
  });

  it("speaks on request, reads Stop while it speaks, and stops", async () => {
    const speech = installSpeech();
    await page.openWith([message(1, { text: "First. Second." })]);
    fireEvent.click(option(1, "Read aloud"));
    expect(speech.spoken).toEqual(["First."]);
    speech.finish();
    expect(speech.spoken).toEqual(["First.", "Second."]);
    fireEvent.click(option(1, "Stop"));
    const cancels = speech.cancels();
    speech.finish();
    expect(speech.spoken).toEqual(["First.", "Second."]);
    expect(cancels).toBeGreaterThan(0);
    expect(optionNames(1)).toContain("Read aloud");
  });

  it("stops one message when another is read aloud, and when the page closes", async () => {
    const speech = installSpeech();
    await page.openWith([message(1, { text: "One. Two." }), message(2, { text: "Three." })]);
    fireEvent.click(option(1, "Read aloud"));
    fireEvent.click(option(2, "Read aloud"));
    expect(optionNames(1)).toContain("Read aloud");
    expect(optionNames(2)).toContain("Stop");
    speech.finish();
    expect(speech.spoken).toEqual(["One.", "Three."]);
    const before = speech.cancels();
    cleanup();
    expect(speech.cancels()).toBeGreaterThan(before);
  });

  it("says once when the device cannot speak, and offers Read aloud again", async () => {
    const speech = installSpeech();
    await page.openWith([message(1, { text: "First. Second." })]);
    const article = () => document.getElementById("message-1") as HTMLElement;
    fireEvent.click(option(1, "Read aloud"));
    speech.fail("synthesis-failed");
    await waitFor(() => expect(within(article()).queryByRole("status")).not.toBeNull());
    expect(speech.spoken).toEqual(["First."]);
    expect(optionNames(1)).toContain("Read aloud");
    // Reading again clears it; a stop cuts an utterance off quietly.
    fireEvent.click(option(1, "Read aloud"));
    expect(within(article()).queryByRole("status")).toBeNull();
    speech.fail("interrupted");
    expect(within(article()).queryByRole("status")).toBeNull();
  });

  it("is offered on a replaced message too", async () => {
    installSpeech();
    await page.openWith([
      message(1, { text: "Old.", live: false, replaced_by: 2 }),
      message(2, { text: "New.", replaces: 1 }),
    ]);
    await waitFor(() => optionsButton(2));
    const replaced = document.querySelector("#message-1 summary");
    expect(replaced).not.toBeNull();
    fireEvent.click(replaced as Element);
    await waitFor(() => optionsButton(1));
    expect(optionNames(1)).toEqual(["Read aloud"]);
  });
});
