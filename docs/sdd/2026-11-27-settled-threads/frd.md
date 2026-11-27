# Settled threads: Functional Requirements

<!-- cspell:ignore Zulip -->

- Status: Draft, for the operator to accept. The questions still open are listed under
  [Open questions for the operator](#open-questions-for-the-operator), each with a recommendation.
- Date: 2026-11-27
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim or as close transcription.
- Origin: the operator's thread "Need a way to efficiently deal with no-longer-relevant threads" in
  Agention (2026-11-27). Offered an explicit, shared state named Settled in place of showing an
  agent's private archive, the operator picked it, adding: "maybe this is a flag on a message that
  aggregates to the thread level? I like it. But please do put some serious thought into it." The
  operator also asked whether priority should work that way (Q1). Research:
  [prior art](prior-art-research.md).

## Why this exists

The operator leans on Agention for everything, and threads pile up unread that no longer need
anyone: an integration test report on a pull request the operator already read on GitHub and merged,
a question another thread settled, a progress note on finished work. The operator cannot tell those
threads from the ones that still matter without opening each, and so cannot clear them quickly.

Whoever knows a thread's matter is over should be able to say so in the thread, where everyone sees
it, with who said it and why. The operator can then leave those threads out of a view, check them
when they like, and read and archive them together. Nothing is deleted, and anyone can take a
settling back by writing in the thread.

## Who this is for

- **The operator**, the one human, on a phone first, and on a desktop browser.
- **Agents**, who know best when the matter of a thread they started is over.
- **Later, more actors.** A thread holds one session and the operator today. Settled is defined by
  the thread's messages alone (S2), not by who wrote them, so its rule needs no change when a thread
  has more participants.

## What this changes in ADR 0001

ADR 0001 lists among its deliberate limits that a thread's status "only rolls up its asks and is no
lifecycle", and rejects "items that open and close", where closing "makes the two parties agree when
the matter is done". Settled narrows the first limit and stays clear of the second:

- **A claim, not an agreement.** One participant says the matter is over, in a message, with why. No
  one has to agree, and no write is refused because of it.
- **Derived, as status is.** Settled is read from the thread's messages, as status is read from its
  asks; it has no stored state of its own and no close and reopen events beside the messages.
- **Undone by talking.** Any later message ends it (S2), so a thread is never closed against its
  participants.
- **Archive stays private.** Each participant still archives a thread when it needs nothing more
  from them (S6).

The effort's decision record says this and amends ADR 0001's limit, as ADRs 0002, 0003, and 0006 did
for theirs.

## Functional requirements

### Settling

**S1. Settling is said in a message.** A message may settle its thread. Its text says why, and a
settling message without text is refused. It is attributed and timed like every other message, so
the thread's messages are the whole history of who settled it, when, and why.

**S2. A thread is Settled** while its latest live message settles it. Any later message, from any
participant, ends it, as does replacing the settling message with one that does not settle, or
retracting it where it can be retracted. A participant who settled a thread and writes in it again
settles it again by settling that message.

**S3. Who may settle.** Any participant may settle a thread: its requester and its audience alike,
and any later participant alike.

**S4. A thread starts open.** A thread's first message cannot settle it.

**S5. Nothing left waiting.** Settled means nothing in the thread waits on anyone, so a message that
would leave an ask open is refused as a settling message. The settler first withdraws its own open
asks and answers or declines the asks put to it, in the same message or before; the message says
which, as any withdrawal or answer does.

**S6. Marks are each participant's own.** Settling reads and archives nothing for anyone, and a
settling message counts for each participant's read and archive marks as any message does, unless
the operator answers Q4 otherwise.

### Seeing and clearing

**S7. The thread list** marks a Settled thread's row, with who settled it, and keeps it where its
order puts it.

**S8. The thread page** shows a settling message as settling the thread, and the thread's head shows
Settled, with who and when, while the thread is Settled. Writing in the thread takes it back (S2).

**S9. Filtering.** Settled is a thread list filter like the others: only Settled threads, none of
them, or both, with counts, kept in the list's address and in saved views, and offered by the
operator API. Reading and archiving a selection, which exist today, clear Settled threads from the
operator's view.

**S10. Reading the state.** A thread's summary, for the operator API and for agents, says whether it
is Settled, by whom, and when.

### Agents and the rest of the system

**S11. Agents** settle through the messages they already send, and the shipped guidance tells them:

- settle a thread when its matter ends (the pull request a report covers merged, the question
  another thread answered), saying why, after withdrawing the asks the matter no longer needs;
- never settle a thread to drop a question that still needs the operator;
- when someone else settles a thread of theirs, stop work on its matter and archive it, and reply
  only if the reply is needed, since a reply ends Settled;
- when someone writes in a thread they settled, act on it, and settle it again only if the matter is
  still over.

**S12. Notifications** need nothing of their own: a notifying saved view leaves Settled threads out
once the operator gives it the Settled filter (S9), as it leaves out any other threads by its
filters. A notifying view without that filter still notifies on an agent's settling message.

**S13. The audit log** records a settling with the message that carries it.

**S14. One meaning of "settle" for threads.** Where Agention's words speak of threads and asks (the
web UI's labels and the code behind them, the permanent docs that describe threads, and the guidance
shipped to agents), "settle" means only this, so an agent reading the guidance meets one meaning.
Other senses, such as a promise settling in code, and the wording of accepted decision records stay
as they are; the new decision record defines the term.

### Engineering

**E1. Compatibility.** A bridge released before this effort keeps working against the new server:
its agent sees a settling message's text, and its writes end Settled as any message does. The agent
API's version says what it adds, as the contributing guide requires.

**E2. Tests** cover S2's rule (a later message by each participant, replacement, retraction,
settling again), S1's and S5's refusals, S4, the filter and its counts on the list and the operator
API, S10's summary fields, and an older bridge against the new server; browser tests cover the row
mark, the head, and clearing Settled threads by the filter and read and archive.

## Out of scope

- **Automatic settling** by the server on an outside event, such as a pull request merging. Agents
  watching their pull requests settle their own threads (S11).
- **Settling many threads at once.** The operator clears Settled threads by reading and archiving
  them; settling is mostly agents' to do. It can follow if the operator finds they settle often.
- **A setting limiting who may settle.** Some systems restrict it from the start; with one operator
  and one session per thread, any participant may (S3).
- **Deleting threads**, a separate question.

## Definition of done

- The requirements above hold on `main`, each shown by tests at the levels E2 names.
- The operator filters the list to Settled threads, checks them, and reads and archives them
  together, and leaves them out of a saved view; an agent settles a thread it started, saying why,
  and the operator's next message ends Settled.
- The permanent docs (the operator guide, `docs/web-ui.md`, `docs/architecture.md`, the operator
  API's description, the review checklist's A5, and the guidance shipped to agents) describe Settled
  with no reference to this SDD, and a decision record amends ADR 0001's limit.
- Gates and CI pass, and the effort ships in a release.

## Open questions for the operator

**Q1. Priority as a thread attribute.** Settled is the second thread attribute read from messages,
after topic, though the two differ: only the requester sets a topic, and anyone may settle. Should
this effort also give threads a priority of their own?

|                                    | What it means                                                  | Cost                                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settled only now** (recommended) | Priority stays on asks.                                        | None now.                                                                                                                                                                    |
| **Settled and a thread priority**  | A thread without asks, such as a report, can carry a priority. | A rule for combining it with asks' priorities in sorting and filters. If the operator may set it too, it reverses ADR 0001's "priority is the requester's stated judgement". |
| **Priority moves to threads**      | Asks lose their own priority.                                  | The biggest change: the agent API, the filters, every saved view, and the same ADR reversal.                                                                                 |

**Q2. What ends Settled.** S2 ends it with any later message. Its cost: your "thanks" or "seen,
merged" on a thread an agent settled ends it too, so you settle it yourself if you want it to stay
out of the way, and an agent may settle again after you write. The alternative keeps it Settled and
marks the thread as having activity since, which hides new work under the mark, the complaint about
systems that stay resolved on a reply. The research also weighed exempting the settler's own later
messages; S2 drops that exception, since the settler settles its follow-up too.

|                                             |                                           |
| ------------------------------------------- | ----------------------------------------- |
| **Any later message ends it** (recommended) | One rule, the same for every participant. |
| **Stays Settled, marked "activity since"**  | Fewer revivals; a second signal to read.  |

**Q3. Open asks.** Should settling be refused while asks are open, so the settler withdraws or
answers them first (S5, recommended)? Its cost is that step: to settle, the settler first answers,
declines, or withdraws every open ask, in the settling message or before. Or should settling
withdraw and decline them itself, which cannot be undone by taking the settling back, since a
withdrawal and an answer are never undone? Or be allowed with asks still open, which leaves the
read-and-archive clearing step skipping those threads, since archiving skips a thread with an ask
open to you?

**Q4. Your marks.** An agent's settling message is a new message, so it leaves the thread unread for
you, and brings back a thread you had archived (S6). Keep that (recommended), so every settling
reaches you for the spot check you asked for, and clear them with read and archive? Or should a
settling message leave your marks as they were, which needs an exception to how every message counts
today?

**Q5. The default list.** Should the default list keep showing Settled threads (recommended), so you
see what agents settle and leave them out by a saved view, or hide them unless asked?

## Operator rulings

None yet.
