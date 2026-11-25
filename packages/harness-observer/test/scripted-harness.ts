// A scripted stand-in for an agent harness, which the observer's tests run in
// a real tmux pane. It draws one of a few screens and switches between them
// on a key, so a test drives it with tmux's send-keys; a key that is one of
// these letters alone switches, and any other goes to the input line:
//
// - p: at its prompt, "> " and the input line, with the cursor at its end;
// - e: at its prompt with a draft, the cursor showing in the middle of it;
// - r: running a turn, redrawing a counter every 200 ms, the prompt live;
// - d: a dialog, still, with the cursor hidden;
// - l: at its prompt, under a line saying a usage limit was reached.
//
// It starts at its prompt, and asks for bracketed paste. At its prompt the
// input line takes pastes and typed characters, Backspace removes the last
// character, and Enter submits what the line holds: the harness runs a turn
// for a second, then shows the prompt again, empty, under a line counting
// the turns. A dialog drops pastes. Options change that, as real harnesses
// in other modes do:
//
// - --backspace-moves: Backspace moves the cursor left and deletes nothing,
//   as in vim's normal mode;
// - --enter-ignored: Enter does nothing;
// - --dialog-at-second-paste: the second paste opens the dialog, which drops
//   it, as a dialog that opens just then does.

type Mode = "prompt" | "editing" | "running" | "dialog" | "limited";

const options = new Set(process.argv.slice(2));
const escape = "\u001b[";
const pasteStart = `${escape}200~`;
const pasteEnd = `${escape}201~`;
const modes: Record<string, Mode> = {
  p: "prompt",
  e: "editing",
  r: "running",
  d: "dialog",
  l: "limited",
};
let mode: Mode = "prompt";
let turn = 0;
let turns = 0;
let timer: NodeJS.Timeout | undefined;
// The input line's text, and the cursor's place in it.
let typed = "";
let cursor = 0;
// Where a paste in progress has got to, or undefined outside one.
let pasting: string | undefined;
let pastes = 0;

// at moves the cursor to a column and row from 0.
function at(x: number, y: number): string {
  return `${escape}${y + 1};${x + 1}H`;
}

function draw(): void {
  let screen = `${escape}2J${at(0, 0)}scripted harness`;
  const prompt = `${at(0, 2)}> ${typed}${at(2 + cursor, 2)}${escape}?25h`;
  switch (mode) {
    case "prompt":
      screen += (turns > 0 ? `${at(0, 1)}turns ${turns}` : "") + prompt;
      break;
    case "editing":
      screen += `${at(0, 2)}> a draft${at(4, 2)}${escape}?25h`;
      break;
    case "running":
      screen += `${at(0, 1)}working ${turn}${prompt}`;
      break;
    case "dialog":
      screen += `${at(0, 2)}Allow this action?${at(0, 3)}> 1. Yes${at(0, 4)}  2. No${escape}?25l`;
      break;
    case "limited":
      screen += `${at(0, 1)}usage limit reached${prompt}`;
      break;
  }
  process.stdout.write(screen);
}

function switchTo(next: Mode): void {
  mode = next;
  clearInterval(timer);
  timer = undefined;
  if (mode === "running") {
    timer = setInterval(() => {
      turn++;
      draw();
    }, 200);
  }
  draw();
}

// atInput says whether the input line takes what is typed and pasted.
function atInput(): boolean {
  return mode === "prompt" || mode === "limited";
}

function insert(text: string): void {
  if (atInput()) {
    typed = typed.slice(0, cursor) + text + typed.slice(cursor);
    cursor += text.length;
  }
}

function backspace(): void {
  if (!atInput() || cursor === 0) {
    return;
  }
  cursor--;
  if (!options.has("--backspace-moves")) {
    typed = typed.slice(0, cursor) + typed.slice(cursor + 1);
  }
}

function enter(): void {
  if (!atInput() || options.has("--enter-ignored") || typed === "") {
    return;
  }
  typed = "";
  cursor = 0;
  switchTo("running");
  setTimeout(() => {
    turns++;
    switchTo("prompt");
  }, 1000);
}

// take handles what arrived on the terminal: a paste between its brackets,
// Backspace, Enter, other escape sequences, which it ignores, and characters.
function take(data: string): void {
  let rest = data;
  while (rest !== "") {
    if (pasting !== undefined) {
      const end = rest.indexOf(pasteEnd);
      if (end < 0) {
        pasting += rest;
        return;
      }
      pastes++;
      if (pastes === 2 && options.has("--dialog-at-second-paste")) {
        mode = "dialog";
      }
      insert(pasting + rest.slice(0, end));
      pasting = undefined;
      rest = rest.slice(end + pasteEnd.length);
    } else if (rest.startsWith(pasteStart)) {
      pasting = "";
      rest = rest.slice(pasteStart.length);
    } else if (rest.startsWith("\u001b")) {
      // An escape sequence: CSI's parameters run to a final byte from "@".
      const sequence = /^\u001b\[[0-?]*[ -/]*[@-~]|^\u001b./.exec(rest);
      rest = rest.slice(sequence?.[0].length ?? 1);
    } else {
      const character = rest[0]!;
      rest = rest.slice(1);
      if (character === "\u007f") {
        backspace();
      } else if (character === "\r") {
        enter();
      } else if (character >= " ") {
        insert(character);
      }
    }
  }
}

process.stdin.setRawMode(true);
process.stdin.on("data", (data: Buffer) => {
  const text = data.toString("utf8");
  const next = modes[text];
  if (next !== undefined) {
    typed = "";
    cursor = 0;
    switchTo(next);
    return;
  }
  take(text);
  if (mode !== "running") {
    draw();
  }
});
process.stdout.write(`${escape}?2004h`);
switchTo("prompt");
