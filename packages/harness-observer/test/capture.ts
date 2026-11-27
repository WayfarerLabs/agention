// Captures the screen of the one pane of a tmux server, as the observer reads
// it, into a capture file for the profiles' tests:
//
//   node test/capture.ts <socket> <file>
//
// The file holds the screen as it is, so scrub it before adding it to
// src/captures; the package's README says how.
import { writeFileSync } from "node:fs";
import { TmuxPane } from "../src/tmux-pane.ts";
import { formatCapture } from "./captures.ts";

const [socket, file] = process.argv.slice(2);
if (socket === undefined || file === undefined) {
  console.error("Usage: node test/capture.ts <socket> <file>");
  process.exit(2);
}
writeFileSync(file, formatCapture(await new TmuxPane(socket).snapshot()));
