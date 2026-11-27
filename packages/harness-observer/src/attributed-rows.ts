import type { FaintRun } from "./pane.ts";

// readAttributedRows reads a screen's rows as a terminal server prints them
// with their attributes, as tmux's `capture-pane -e` does: the text of each
// row, its trailing spaces trimmed, and the runs of faint text on them, drawn
// with SGR 2 until SGR 22 or 0 ends it. Every other escape sequence is left
// out of the text: a CSI sequence, an OSC string ended by BEL or ST, any
// other escape sequence, and any other C0 control character, such as the
// shift-out and shift-in tmux puts around line-drawing characters, so a
// row's text is what `capture-pane -p` prints for it. A color's own
// parameters, such as the 2 of 38;2;r;g;b, never read as faint. Attributes
// run on from one row to the next, as the server's output does.
export function readAttributedRows(rows: readonly string[]): {
  lines: string[];
  faint: FaintRun[];
} {
  const lines: string[] = [];
  const faint: FaintRun[] = [];
  let dim = false;
  rows.forEach((row, index) => {
    const characters: string[] = [];
    const dimmed: boolean[] = [];
    let i = 0;
    while (i < row.length) {
      if (row[i] !== "\u001b" && row.charCodeAt(i) < 0x20) {
        i++;
        continue;
      }
      if (row[i] !== "\u001b") {
        const character = String.fromCodePoint(row.codePointAt(i)!);
        characters.push(character);
        dimmed.push(dim);
        i += character.length;
        continue;
      }
      const next = row[i + 1];
      if (next === "[") {
        const sequence = /^\u001b\[([0-?]*)[ -/]*([@-~])/.exec(row.slice(i));
        if (sequence === null) {
          break;
        }
        if (sequence[2] === "m") {
          dim = applySgr(sequence[1] ?? "", dim);
        }
        i += sequence[0].length;
      } else if (next === "]") {
        const end = /\u0007|\u001b\\/.exec(row.slice(i + 2));
        i = end === null ? row.length : i + 2 + end.index + end[0].length;
      } else {
        const sequence = /^\u001b[ -/]*[0-~]?/.exec(row.slice(i));
        i += sequence?.[0].length ?? 1;
      }
    }
    while (characters.at(-1) === " ") {
      characters.pop();
      dimmed.pop();
    }
    lines.push(characters.join(""));
    let from: number | undefined;
    dimmed.forEach((isDim, at) => {
      if (isDim && from === undefined) {
        from = at;
      } else if (!isDim && from !== undefined) {
        faint.push({ row: index, from, to: at });
        from = undefined;
      }
    });
    if (from !== undefined) {
      faint.push({ row: index, from, to: dimmed.length });
    }
  });
  return { lines, faint };
}

// applySgr gives whether text is faint after an SGR sequence's parameters.
function applySgr(parameters: string, dim: boolean): boolean {
  const parts = parameters === "" ? ["0"] : parameters.split(";");
  let faint = dim;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes(":")) {
      continue;
    }
    const code = Number(part === "" ? "0" : part);
    if (code === 0 || code === 22) {
      faint = false;
    } else if (code === 2) {
      faint = true;
    } else if (code === 38 || code === 48 || code === 58) {
      i += parts[i + 1] === "5" ? 2 : parts[i + 1] === "2" ? 4 : 0;
    }
  }
  return faint;
}
