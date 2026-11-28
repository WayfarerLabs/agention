# 9. Settled threads: a claim in a message that a thread's matter is over

Date: 2026-11-27

## Status

Accepted. Narrows "A thread's status only rolls up its asks and is no lifecycle" in "Not doing" of
[ADR 0001](0001-agention-v1-architecture.md): a thread is also Settled while its latest message
settles it. ADR 0001's rejected alternative "Items that open and close" stays rejected.

## Context

The operator leans on Agention for everything, and threads pile up unread that no longer need
anyone: a report on a pull request the operator already read and merged, a question another thread
answered, a progress note on finished work. The operator could not tell them from the threads that
still matter without opening each, and so could not clear them quickly. Each party's archive mark is
its own, so an agent archiving a thread it is done with tells the operator nothing.

Whoever knows a thread's matter is over is usually the agent that started it. The operator asked for
a shared, explicit state, "a flag on a message that aggregates to the thread level".

## Decision

In this decision record and wherever Agention's words speak of threads and asks, "settle" means only
this: one participant says, in a message, that the thread's matter is over.

- **A claim, in a message.** A message may settle its thread, and its text says why; one without
  text is refused. It is attributed and timed like every other message, so the thread's messages are
  the whole history of who settled it, when, and why.
- **Derived, as status is.** A thread is Settled while its latest message settles it. Nothing on the
  thread stores it, and there are no close or reopen events beside the messages: the latest message
  is always live, so one join reads it.
- **Undone by talking.** Any later message ends it, from either party: a reply, a replacement that
  does not settle again, or a retraction. Whoever settled it settles it again by settling a later
  message. A thread is never closed against its participants, and no write is refused because it is
  Settled.
- **Either party, no role check.** The requester and the audience alike may settle, and so may any
  later participant, since the rule reads only the thread's messages.
- **Nothing left waiting.** Settled means nothing in the thread waits on anyone, so a settling
  message is refused while any ask would stay open after it. The settler resolves them first, in the
  same message or before, as any withdrawal or answer does: the requester withdraws its own, and the
  audience answers or declines those put to it. This is a rule on one part of a message keyed on
  open asks, as the replacement rules are, not an action a derived signal triggers.
- **A thread starts open.** Its first message cannot settle it.
- **Archive stays each party's own.** Settling reads and archives nothing for anyone, and a settling
  message counts for each party's read and archive marks as any message does, so every settle
  reaches the operator for a spot check. The operator clears Settled threads with the thread list's
  Settled filter, reading and archiving them together.

## Consequences

- The operator can leave Settled threads out of a view, or list only them, and a saved view that
  notifies leaves them out once it carries the filter, with nothing of its own for notifications.
- Agents settle through the messages they already send, and the guidance shipped to them says when:
  when a thread's matter ends, never to drop a question that still needs the operator, and, when
  someone else settles a thread of theirs, to stop work on it and archive it, replying only if the
  reply is needed, since a reply ends Settled.
- A bridge released before this decision keeps working: it cannot settle, sees a settling message as
  its text, and ends Settled by writing, as any message does.
- A participant who disagrees says so in the thread, which ends Settled; there is no way to settle
  against the other party or to keep a thread Settled through a reply.

## Alternatives considered

- **Showing an agent's private archive to the operator.** It would tell the operator only that the
  agent was done with its side, not why, and archive would stop being each party's own.
- **A stored state with close and reopen events.** It is ADR 0001's rejected "items that open and
  close": a lifecycle beside the messages, which the parties would have to agree on.
- **Settling with asks still open, or closing them automatically.** It would drop a question
  unexplained; the settler resolves each explicitly instead.
- **Settling by the server on an outside event**, such as a pull request merging: the agents
  watching their pull requests settle their own threads.
- **A priority of threads' own.** Priority stays on asks.
