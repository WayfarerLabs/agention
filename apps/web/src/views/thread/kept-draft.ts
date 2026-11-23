import { useEffect, useRef, useState } from "react";
import {
  type DraftThread,
  forgetDraft,
  keepDraft,
  type KeptDraft,
  signOutMark,
} from "../../device.ts";
import { blank } from "./writer.ts";

// useKeptDraft keeps a thread's draft in this browser as it changes, while
// keep says there is one to keep, and forgets the draft this page kept once
// there is none, while it is still the one this page kept: a draft another
// tab kept since stays, so the draft typed last is the one kept. It gives
// keepNow, which keeps at once what is left of the draft once
// a write lands, the text and details typed meanwhile, counting from at least
// the message written, or forgets it when nothing is left: the page may be
// left as the write lands, before the composer shows what is left.
export function useKeptDraft(
  thread: DraftThread,
  draft: Omit<KeptDraft, "kept">,
  keep: boolean,
): (text: string, detail: string, written: number) => void {
  // The browser's sign-out mark as the page opened, so a draft is not kept
  // once the browser signed out since.
  const [since] = useState(signOutMark);
  // The record of the draft this page last kept, while it keeps one.
  const kept = useRef<string | undefined>(undefined);
  const latest = useRef(draft);
  const { text, detail, basis, leftBehind } = draft;
  useEffect(() => {
    latest.current = { text, detail, basis, leftBehind };
    if (keep) {
      kept.current = keepDraft(thread, { text, detail, basis, leftBehind }, since);
    } else if (kept.current !== undefined) {
      forgetDraft(thread, kept.current);
      kept.current = undefined;
    }
  }, [text, detail, basis, leftBehind, keep, thread, since]);

  return (left, leftDetail, written) => {
    if (blank(left) && blank(leftDetail)) {
      if (kept.current !== undefined) {
        forgetDraft(thread, kept.current);
        kept.current = undefined;
      }
      return;
    }
    kept.current = keepDraft(
      thread,
      {
        text: left,
        detail: leftDetail,
        basis: Math.max(latest.current.basis, written),
        leftBehind: latest.current.leftBehind,
      },
      since,
    );
  };
}
