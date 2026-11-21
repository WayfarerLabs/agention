import type { Message } from "@wayfarerlabs/agention-api";
import type { Nodes } from "mdast";
import { useSyncExternalStore } from "react";
import { opensTooManyBlocks, parseMarkdown, plainText } from "../markdown/Markdown.tsx";

// Read aloud: a message spoken as words by the browser's own speech, on the
// device, only when the operator asks. One message speaks at a time, and
// Stop, reading another message aloud, starting a recording or leaving the
// thread stops it at once. It is spoken a sentence at a time, since browsers
// cut a long utterance off partway.

export function speechSupported(): boolean {
  return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

// blockWords says a Markdown text's top-level blocks as words, one string a
// block: the inline text of each paragraph, heading and table row, walking
// into lists and quotes, and "Code block." or "Diagram." in place of a fenced
// block's contents. A text the renderer shows unparsed is said as it is.
function blockWords(text: string): string[] {
  if (opensTooManyBlocks(text)) {
    return [text];
  }
  const said: string[] = [];
  const pending: Nodes[] = [...parseMarkdown(text).children].reverse();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    switch (node.type) {
      case "code":
        said.push(node.lang === "mermaid" ? "Diagram." : "Code block.");
        break;
      case "paragraph":
      case "heading":
      case "tableRow":
        said.push(
          node.type === "tableRow"
            ? node.children.map((cell) => plainText(cell)).join(", ")
            : plainText(node),
        );
        break;
      case "html":
        said.push(node.value);
        break;
      case "list":
      case "listItem":
      case "blockquote":
      case "table":
        pending.push(...[...node.children].reverse());
        break;
      default:
        // Thematic breaks and link definitions say nothing.
        break;
    }
  }
  return said;
}

// sentencesOf splits text into sentences, where the browser can.
function sentencesOf(text: string): string[] {
  const parts =
    typeof Intl.Segmenter === "function"
      ? [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)].map(
          (part) => part.segment,
        )
      : [text];
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

// wordsOf gives what reading a message aloud says, a sentence at a time: its
// text and detail, then each ask with its suggested answers, and each answer
// with what it chose.
export function wordsOf(message: Message): string[] {
  const blocks = [
    ...(message.text === undefined ? [] : blockWords(message.text)),
    ...(message.detail === undefined ? [] : blockWords(message.detail)),
    ...(message.asks ?? []).map((ask) => {
      const options = ask.suggestions.map((suggestion) => suggestion.label);
      return `Ask ${ask.number}: ${ask.question}${options.length === 0 ? "" : ` Options: ${options.join(", ")}.`}`;
    }),
    ...(message.answers ?? []).map((answer) =>
      answer.declined
        ? `Declined ask ${answer.ask}.`
        : `Answered ask ${answer.ask}: ${[...(answer.labels ?? []), ...(answer.text === undefined ? [] : [answer.text])].join(". ")}`,
    ),
  ];
  return blocks.flatMap(sentencesOf);
}

// What is speaking: the key of the message, or undefined.
let speaking: string | undefined;
// What the device could not read aloud, until anything is read or stopped.
let failed: string | undefined;
// Each reading's own number, so the end of a stopped one does nothing.
let reading = 0;
const listeners = new Set<() => void>();

function setSpeaking(key: string | undefined, failure?: string): void {
  speaking = key;
  failed = failure;
  for (const listener of listeners) {
    listener();
  }
}

// stopSpeaking stops whatever is being read aloud.
export function stopSpeaking(): void {
  reading++;
  if (speaking !== undefined || failed !== undefined) {
    setSpeaking(undefined);
  }
  if (speechSupported()) {
    speechSynthesis.cancel();
  }
}

// speak reads sentences aloud under key, a sentence at a time, after
// stopping whatever was being read, in the browser's default voice for the
// page's language.
export function speak(key: string, sentences: string[]): void {
  stopSpeaking();
  if (sentences.length === 0) {
    return;
  }
  const own = reading;
  const language = document.documentElement.lang;
  let next = 0;
  const say = () => {
    if (own !== reading) {
      return;
    }
    const sentence = sentences[next++];
    if (sentence === undefined) {
      setSpeaking(undefined);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(sentence);
    if (language !== "") {
      utterance.lang = language;
    }
    utterance.onend = say;
    // An utterance cut off, by a stop or by another, ends quietly; any
    // other error means the device could not speak it, as one without
    // voices, which is said once.
    utterance.onerror = (event) => {
      if (own === reading) {
        const quiet = event.error === "interrupted" || event.error === "canceled";
        setSpeaking(undefined, quiet ? undefined : key);
      }
    };
    speechSynthesis.speak(utterance);
  };
  setSpeaking(key);
  say();
}

const speakingKey = () => speaking;
const failedKey = () => failed;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// useSpeaking says which message is being read aloud, by its key.
export function useSpeaking(): string | undefined {
  return useSyncExternalStore(subscribe, speakingKey);
}

// useSpeechFailed says which message the device could not read aloud, by
// its key, until anything else is read or reading is stopped.
export function useSpeechFailed(): string | undefined {
  return useSyncExternalStore(subscribe, failedKey);
}
