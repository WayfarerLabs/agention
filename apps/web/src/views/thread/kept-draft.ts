import { useEffect, useRef, useState } from "react";
import {
  type DraftThread,
  forgetDraft,
  keepDraft,
  type KeptDraft,
  replaceDraft,
  signOutMark,
} from "../../device.ts";
import { blank } from "./writer.ts";

// useKeptDraft keeps a thread's draft in this browser as it changes, while
// keep says there is one to keep, and forgets the draft this page kept once
// there is none, while it is still the one this page kept: a draft another
// tab kept since stays, so the draft typed last is the one kept. It gives
// keepNow, which keeps at once what is left of the draft once
// a write lands, the text and details typed meanwhile, counting from at least
// the message written, and whether the composer still holds more, or forgets
// it when nothing is left: the page may be left as the write lands, before the
// composer shows what is left. A write that lands keeps what is left, or forgets
// the draft, only while the stored draft is still the one this page kept (or
// none is stored), so a newer draft typed after the thread was left and
// reopened, or in another tab, stays.
export function useKeptDraft(
  thread: DraftThread,
  draft: Omit<KeptDraft, "kept">,
  keep: boolean,
): (text: string, detail: string, written: number, leftBehind: boolean) => void {
  // The browser's sign-out mark as the page opened, so a draft is not kept
  // once the browser signed out since.
  const [since] = useState(signOutMark);
  // The record of the draft this page last kept, while it keeps one.
  const kept = useRef<string | undefined>(undefined);
  // The starting point as it stands, which what is left once a write lands
  // counts from at least.
  const latestBasis = useRef(draft.basis);
  // What is left that keepNow was refused for. While the composer still holds
  // exactly that, the changes that follow the write landing keep it only as
  // keepNow would, and anything typed since is kept as ever.
  const refused = useRef<{ text: string; detail: string } | undefined>(undefined);
  const { text, detail, basis, leftBehind } = draft;
  useEffect(() => {
    latestBasis.current = basis;
    if (keep) {
      const held = { text, detail, basis, leftBehind };
      if (refused.current?.text === text && refused.current.detail === detail) {
        kept.current = replaceDraft(thread, held, since, kept.current);
      } else {
        refused.current = undefined;
        kept.current = keepDraft(thread, held, since);
      }
    } else {
      refused.current = undefined;
      if (kept.current !== undefined) {
        forgetDraft(thread, kept.current);
        kept.current = undefined;
      }
    }
  }, [text, detail, basis, leftBehind, keep, thread, since]);

  return (left, leftDetail, written, leftBehind) => {
    refused.current = undefined;
    if (blank(left) && blank(leftDetail)) {
      if (kept.current !== undefined) {
        forgetDraft(thread, kept.current);
        kept.current = undefined;
      }
      return;
    }
    kept.current = replaceDraft(
      thread,
      {
        text: left,
        detail: leftDetail,
        basis: Math.max(latestBasis.current, written),
        leftBehind,
      },
      since,
      kept.current,
    );
    if (kept.current === undefined) {
      refused.current = { text: left, detail: leftDetail };
    }
  };
}
