import {
  type SessionSummary,
  type ThreadStartInput,
  threadTitle,
  type WriteResult,
} from "@wayfarerlabs/agention-api";
import {
  type ClipboardEvent,
  type FormEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { request, sessionPath } from "../../api.ts";
import {
  attachmentsOf,
  attachPasted,
  expireRefused,
  sendWait,
  useDraftFiles,
} from "../../attach/attach.ts";
import { AttachButton } from "../../attach/AttachButton.tsx";
import { AttachList } from "../../attach/AttachList.tsx";
import { Failure, PathParts, Sheet } from "../../components.tsx";
import { newRequestId, useAction, useStillOpen } from "../../data.ts";
import { type Absence, AbsenceReason, absenceOf } from "../../format.tsx";
import { navigate } from "../../router.tsx";
import { threadHref } from "../../routes.ts";
import { useDictationInto, useVoiceOn } from "../../voice/Dictation.tsx";
import { blank, draftProblems, failureAt } from "../thread/writer.ts";

// The new-thread sheet: the operator starts a thread on a session with a
// title and a first message, its text, optional detail and the files it
// carries, in a modal dialog that rises from the bottom on a phone as the
// filter sheet does. Its message and Details boxes work as the composer's
// do: Attach and a paste of images add files, each uploaded to the session
// as it is added, which Send waits for, and while voice is on, dictation
// puts its text in the box that last had focus; Send waits for a recording
// too, until its text is in or it is discarded. The session stays the
// thread's requester, so the sheet has no asks. When the session is not
// likely to see the thread soon, the sheet says so, what it waits on and
// why, following the session as the view refreshes. Send opens the new
// thread; leaving the sheet without sending, by closing it or any other way
// it goes, removes its uploads, except those of a start on its way. While a
// start is on its way the sheet holds still: it neither closes nor takes
// files or dictation, so nothing added is left behind.

// awaited says what a session away waits on before it sees a new thread, by
// why it is away: a quiet session may not have ended, and may yet look.
const awaited: Record<Absence["kind"], string> = {
  stopped: "until it is started again",
  quiet: "soon",
  credential: "until you approve a registration for it",
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
  const files = useDraftFiles({ agent, session: session.session });
  const attach = useRef<HTMLButtonElement>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);
  const detailBox = useRef<HTMLTextAreaElement>(null);
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
  const { attachments, ids: fileIds } = attachmentsOf(files.files);
  // Whether dictation is under way: opening the microphone, recording,
  // transcribing or awaiting Retry.
  const [dictating, setDictating] = useState(false);
  // What keeps Send waiting, beside what each field says.
  const waiting = sendWait(files.files, dictating);
  const ready =
    waiting === undefined &&
    !blank(title) &&
    !blank(text) &&
    drafted.title === undefined &&
    drafted.text === undefined &&
    drafted.detail === undefined;
  const edit = (set: (value: string) => void) => (value: string) => {
    send.clear();
    set(value);
  };
  const pasted = attachPasted(files);
  const paste = (event: ClipboardEvent<HTMLElement>) => {
    if (!send.pending) {
      pasted(event);
    }
  };
  const voiceOn = useVoiceOn();
  const { dictation, focused } = useDictationInto({
    boxes: { text: textBox, detail: detailBox },
    first: "text",
    set: (which, value) => edit(which === "detail" ? setDetail : setText)(value),
    disabled: send.pending,
    onActive: setDictating,
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) {
      return;
    }
    const content: Omit<ThreadStartInput, "request_id"> = {
      title,
      text,
      ...(blank(detail) ? {} : { detail }),
      ...(attachments.length === 0 ? {} : { attachments }),
    };
    const written = JSON.stringify(content);
    if (attempt.current?.content !== written) {
      attempt.current = { content: written, requestId: newRequestId() };
    }
    const body: ThreadStartInput = { ...content, request_id: attempt.current.requestId };
    // Leaving the sheet keeps the files the start carries.
    const result = await files.carry(
      fileIds,
      () =>
        send.run(async (csrf) => {
          try {
            return await request<WriteResult>(
              "POST",
              sessionPath(agent, session.session, "/threads"),
              { csrf, body },
            );
          } catch (failure) {
            expireRefused(files, failure, fileIds);
            throw failure;
          }
        }),
      (result) => result !== undefined,
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
      held={send.pending}
      onSubmit={(event) => void submit(event)}
      foot={
        <>
          <div className="sheet-tools">
            <AttachButton draft={files} attach={attach} disabled={send.pending} />
            {voiceOn && dictation.controls}
          </div>
          <button
            type="button"
            className="secondary"
            disabled={send.pending}
            onClick={() => sheet.current?.close()}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={send.pending || !ready}
            aria-describedby={waiting === undefined ? undefined : `${id}-hold`}
          >
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
            ref={textBox}
            rows={4}
            value={text}
            onFocus={() => focused("text")}
            onChange={(event) => edit(setText)(event.target.value)}
            onPaste={paste}
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
            ref={detailBox}
            rows={4}
            value={detail}
            onFocus={() => focused("detail")}
            onChange={(event) => edit(setDetail)(event.target.value)}
            onPaste={paste}
          />
        )}
      />
      <AttachList draft={files} attach={attach} disabled={send.pending} />
      {waiting !== undefined && (
        <p id={`${id}-hold`} className="hint">
          {waiting}
        </p>
      )}
      {voiceOn && dictation.problem}
      {voiceOn && dictation.said}
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
