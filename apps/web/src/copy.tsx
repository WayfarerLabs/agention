import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

// Copying text to the clipboard from a button that confirms it: a message's
// Copy and a code block's.

// How long a copy's confirmation shows before the control reverts.
const copiedFor = 2_000;

export interface Copying {
  // How the last copy went: copied, briefly, or refused, until the next try.
  outcome: "copied" | "refused" | undefined;
  copy(text: string): void;
}

// useCopy copies text to the clipboard and says how the latest copy went:
// whether it landed or the browser refused the clipboard. A browser without
// a clipboard at all counts as refusing. Where it refuses, the caller says
// so beside what was to be copied, so it can be selected and copied by hand.
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
  const copy = (text: string) => {
    const attempt = ++latest.current;
    setOutcome(undefined);
    const settle = (settled: "copied" | "refused") => {
      if (attempt === latest.current) {
        setOutcome(settled);
      }
    };
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        settle("copied");
      } catch {
        settle("refused");
      }
    })();
  };
  return { outcome, copy };
}

// CopyButton copies text, an icon alone named by its label. It shows a check
// while the copy's confirmation lasts, which a polite live region beside it
// also says. The region is there before it speaks, since a screen reader may
// not announce one that arrives already holding its words; it is a live
// region rather than a status so that it is not one more status on the page.
export function CopyButton({
  label,
  copying,
  text,
}: {
  label: string;
  copying: Copying;
  text: string;
}) {
  const copied = copying.outcome === "copied";
  return (
    <>
      <button
        type="button"
        className="copy-button"
        aria-label={label}
        onClick={() => copying.copy(text)}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">
        {copied ? "Copied." : ""}
      </span>
    </>
  );
}
