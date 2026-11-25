import type { Message } from "@wayfarerlabs/agention-api";
import { useEffect, useRef, useState } from "react";

// markdownOf gives what copying a message puts on the clipboard: its text as
// written, in Markdown, and, while the operator has its details open, its
// detail after a blank line, so what is copied is what the message shows of
// itself. Asks, answers, references and files stay out. A message with
// neither has nothing to copy.
export function markdownOf(message: Message, detailOpen: boolean): string | undefined {
  const parts = [message.text, detailOpen ? message.detail : undefined].filter(
    (part) => part !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

// How long a copy's confirmation shows before the control reverts.
const copiedFor = 2_000;

export interface Copying {
  // How the last copy went: copied, briefly, or refused, until the next try.
  outcome: "copied" | "refused" | undefined;
  copy(markdown: string): void;
}

// useCopy copies Markdown to the clipboard and says how the latest copy went:
// whether it landed or the browser refused the clipboard. A browser without
// a clipboard at all counts as refusing.
export function useCopy(): Copying {
  const [outcome, setOutcome] = useState<"copied" | "refused">();
  // Which copy is the latest: one started earlier may settle after it, and
  // only the latest says how copying went.
  const latest = useRef(0);
  useEffect(() => {
    if (outcome !== "copied") {
      return;
    }
    const timer = setTimeout(() => setOutcome(undefined), copiedFor);
    return () => clearTimeout(timer);
  }, [outcome]);
  const copy = (markdown: string) => {
    const attempt = ++latest.current;
    setOutcome(undefined);
    const settle = (settled: "copied" | "refused") => {
      if (attempt === latest.current) {
        setOutcome(settled);
      }
    };
    void (async () => {
      try {
        await navigator.clipboard.writeText(markdown);
        settle("copied");
      } catch {
        settle("refused");
      }
    })();
  };
  return { outcome, copy };
}
