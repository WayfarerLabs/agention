import {
  type SessionSummary,
  type ThreadStartInput,
  threadTitle,
  type WriteResult,
} from "@wayfarerlabs/agention-api";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { request, sessionPath } from "../../api.ts";
import { Failure, PathParts, Sheet } from "../../components.tsx";
import { newRequestId, useAction, useStillOpen } from "../../data.ts";
import { type Absence, AbsenceReason, absenceOf } from "../../format.tsx";
import { navigate, threadHref } from "../../router.tsx";
import { blank, draftProblems, failureAt } from "../thread/writer.ts";

// The new-thread sheet: the operator starts a thread on a session with a
// title and a first message, its text and optional detail, in a modal dialog
// that rises from the bottom on a phone as the filter sheet does. The
// session stays the thread's requester, so the sheet has no asks. When the
// session is not likely to see the thread soon, the sheet says so, what it
// waits on and why, following the session as the view refreshes. Send opens
// the new thread.

// awaited says what a session away waits on before it sees a new thread, by
// why it is away: a quiet session may not have ended, and may yet look.
const awaited: Record<Absence["kind"], string> = {
  stopped: "until it is started again",
  quiet: "soon",
  credential: "until you approve a registration for it",
  disconnected: "until its bridge connects again",
};

// titleProblem says why a title cannot be sent, in the API's words for the
// rule it breaks, once anything is typed.
function titleProblem(title: string): string | undefined {
  const read = threadTitle.safeParse(title);
  return title === "" || read.success
    ? undefined
    : `The title ${read.error.issues[0]?.message ?? "cannot be used"}.`;
}

// NewThreadSheet opens as it mounts, with focus on its heading, so a phone's
// keyboard does not rise over the warning; onClose runs once it closes
// without sending, by Cancel or Escape.
export function NewThreadSheet({
  agent,
  session,
  onClose,
}: {
  agent: string;
  session: SessionSummary;
  onClose: () => void;
}) {
  const id = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [detail, setDetail] = useState("");
  const send = useAction();
  const stillOpen = useStillOpen();
  // A retry keeps its request id while what it sends is unchanged, so a
  // start that landed though its answer was lost is not made twice.
  const attempt = useRef<{ content: string; requestId: string }>(undefined);

  const absence = absenceOf({
    state: session.status?.state,
    outcome: session.status?.outcome,
    presence: session.presence,
    credential_active: session.registrations.length > 0,
  });
  // What is wrong with each field as typed, and then what the server refused
  // of it, until the field changes.
  const drafted = { title: titleProblem(title), ...draftProblems({ text, detail }) };
  const refused = (field: string) => failureAt(send.failure, field);
  const atField = ["title", "text", "detail"].some((field) => refused(field) !== undefined);
  const ready =
    !blank(title) &&
    !blank(text) &&
    drafted.title === undefined &&
    drafted.text === undefined &&
    drafted.detail === undefined;
  const edit = (set: (value: string) => void) => (value: string) => {
    send.clear();
    set(value);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) {
      return;
    }
    const content: Omit<ThreadStartInput, "request_id"> = {
      title,
      text,
      ...(blank(detail) ? {} : { detail }),
    };
    const written = JSON.stringify(content);
    if (attempt.current?.content !== written) {
      attempt.current = { content: written, requestId: newRequestId() };
    }
    const body: ThreadStartInput = { ...content, request_id: attempt.current.requestId };
    const result = await send.run((csrf) =>
      request<WriteResult>("POST", sessionPath(agent, session.session, "/threads"), {
        csrf,
        body,
      }),
    );
    if (result !== undefined && stillOpen()) {
      navigate(threadHref(agent, session.session, result.number));
    }
  };

  return (
    <Sheet
      sheet={sheet}
      heading="New thread"
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      foot={
        <>
          <button type="button" className="secondary" onClick={() => sheet.current?.close()}>
            Cancel
          </button>
          <button type="submit" disabled={send.pending || !ready}>
            Send
          </button>
        </>
      }
    >
      <p className="muted">
        To{" "}
        <PathParts
          place={[
            ["agent", agent],
            ["session", session.session],
          ]}
        />
        {session.status?.title !== undefined && ` · ${session.status.title}`}
      </p>
      {absence !== undefined && (
        <p className="notice warning">
          This session is not likely to see the thread {awaited[absence.kind]}:{" "}
          <AbsenceReason absence={absence} />. The thread shows as stranded until the session reads
          it.
        </p>
      )}
      <Field
        id={`${id}-title`}
        label="Title"
        error={drafted.title ?? refused("title")}
        control={(attributes) => (
          <input
            {...attributes}
            value={title}
            onChange={(event) => edit(setTitle)(event.target.value)}
          />
        )}
      />
      <Field
        id={`${id}-text`}
        label="Message"
        hint="Markdown. The agent reads it as your words at its terminal."
        error={drafted.text ?? refused("text")}
        control={(attributes) => (
          <textarea
            {...attributes}
            rows={4}
            value={text}
            onChange={(event) => edit(setText)(event.target.value)}
          />
        )}
      />
      <Field
        id={`${id}-detail`}
        label="Details"
        hint="Optional. Markdown, shown folded under the message."
        error={drafted.detail ?? refused("detail")}
        control={(attributes) => (
          <textarea
            {...attributes}
            rows={4}
            value={detail}
            onChange={(event) => edit(setDetail)(event.target.value)}
          />
        )}
      />
      <Failure failure={atField ? undefined : send.failure} />
    </Sheet>
  );
}

// What a field gives its control: its id, and whether and why what it holds
// cannot be sent.
interface ControlAttributes {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

// Field is one of the sheet's fields: its label, a hint when it has one, the
// control, and why what it holds cannot be sent, when it cannot, each tied
// to the control.
function Field({
  id,
  label,
  hint,
  error,
  control,
}: {
  id: string;
  label: string;
  hint?: string;
  error: string | undefined;
  control: (attributes: ControlAttributes) => ReactNode;
}) {
  const describedBy = [
    ...(hint === undefined ? [] : [`${id}-hint`]),
    ...(error === undefined ? [] : [`${id}-error`]),
  ].join(" ");
  return (
    <>
      <label htmlFor={id}>{label}</label>
      {hint !== undefined && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {control({
        id,
        ...(error === undefined ? {} : { "aria-invalid": true }),
        ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
      })}
      {error !== undefined && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </>
  );
}
