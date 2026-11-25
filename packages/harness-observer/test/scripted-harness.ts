// A scripted stand-in for an agent harness, which the observer's tests run in
// a real tmux pane. It draws one of a few screens and switches between them
// on a key, so a test drives it with tmux's send-keys:
//
// - p: at its prompt, "> " with the cursor showing after it;
// - e: at its prompt with a draft, the cursor showing in the middle of it;
// - r: running a turn, redrawing a counter every 200 ms, the prompt live;
// - d: a dialog, still, with the cursor hidden.
//
// It starts at its prompt.

type Mode = "prompt" | "editing" | "running" | "dialog";

const escape = "\u001b[";
const modes: Record<string, Mode> = { p: "prompt", e: "editing", r: "running", d: "dialog" };
let mode: Mode = "prompt";
let turn = 0;
let timer: NodeJS.Timeout | undefined;

// at moves the cursor to a column and row from 0.
function at(x: number, y: number): string {
  return `${escape}${y + 1};${x + 1}H`;
}

function draw(): void {
  let screen = `${escape}2J${at(0, 0)}scripted harness`;
  switch (mode) {
    case "prompt":
      screen += `${at(0, 2)}> ${escape}?25h`;
      break;
    case "editing":
      screen += `${at(0, 2)}> a draft${at(4, 2)}${escape}?25h`;
      break;
    case "running":
      screen += `${at(0, 1)}working ${turn}${at(0, 2)}> ${escape}?25h`;
      break;
    case "dialog":
      screen += `${at(0, 2)}Allow this action?${at(0, 3)}> 1. Yes${at(0, 4)}  2. No${escape}?25l`;
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

process.stdin.setRawMode(true);
process.stdin.on("data", (data: Buffer) => {
  const next = modes[data.toString("utf8")];
  if (next !== undefined) {
    switchTo(next);
  }
});
switchTo("prompt");
