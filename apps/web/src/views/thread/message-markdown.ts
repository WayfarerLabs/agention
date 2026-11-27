import type { Message } from "@wayfarerlabs/agention-api";

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
