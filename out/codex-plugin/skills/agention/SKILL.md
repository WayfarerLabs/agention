---
name: agention
description: >-
  How to work with Agention, the attention inbox you share with your user, the operator: every
  question, decision or approval goes there, never to a question tool that waits for an answer
  (AskUserQuestion, request_user_input), and so does anything else they would want to know. Load it
  whenever you use Agention: at the start of every conversation, and before you ask your user
  anything.
---

# Agention

## Attention is the bottleneck

As agents grow more capable, what limits the work is the operator's attention. Agention is one inbox
for it, whatever host runs you: you bring the operator what needs them, they answer when they can,
and you keep working meanwhile.

Every question, decision or approval for the operator goes to them as an ask in Agention, whatever
calls for it: your own judgment, your host's guidance, another skill or a workflow. Never use a
question tool that waits for an answer (`AskUserQuestion` in Claude Code, `request_user_input` in
Codex), and never end your turn to wait for one at your terminal: either stops your work until
someone answers there, and the operator is often not there. When something needs the operator at
your terminal, ask for that through Agention too. Only the operator can tell you otherwise.

## The model

- **Operator**: your user, whose attention Agention serves.
- **Agent** and **session**: you, under a name you keep, and this line of your work. An agent runs
  any number of sessions, each with threads of its own.
- **State**: what your session is doing, which tells the operator whether what they write reaches
  you: `working` while you do something; `idle` while nothing is left but waiting, for the
  operator's answers, CI or a review, and you still check Agention; or `stopped`, with an outcome,
  once you stop checking. Your open asks already tell the operator what waits on them, so a session
  working on one thing while an ask on another is open stays `working`. The note names anything else
  you wait on.
- **Thread**: a conversation with the operator about one matter.
- **Message**: an entry in a thread, yours or the operator's. It tells, and may also carry asks.
- **Ask**: a request in a message for the operator's answer, decision, approval or action. Its
  `impact`, `priority` and `effort` say how it affects your work, what delay costs and what
  answering takes.

## Follow the bridge

Agention's tools come from its bridge, the plugin's `agention` MCP server; your host may prefix
their names. Their descriptions and answers say what to do as you go, and where they are more
specific than this skill, they decide.

**Register** with `register` at the start of every conversation and do what its answer says. If it
asks for names, give an `agent` name that stays the same for you and a `session` name that stays the
same for this line of work. Once registered, report `working` with `session_update`, with a `title`
for this line of work and the `goal` if the operator gave you one. In a new conversation,
`thread_list` with `status: "open"` then shows the threads whose asks you left open.

**How answers reach you** is in the `register` answer, which decides how you check, wait and keep
running in the loop below. Unless it says otherwise, nothing arrives on its own: you check.

## The loop

1. **Write** by starting a thread with `thread_create`, one per matter, with a short `topic` that
   your threads in that area of work share. Later messages on the matter go to its thread with
   `message_send`. A message with no ask is normal and welcome: tell the operator what they would
   want to know, such as progress, a result or an assumption you took.
2. **Ask** by giving a message `asks`, whose fields the tool describes. Put several asks in one
   message only when they belong together, since revising one replaces the message and asks them all
   again under new numbers.
3. **Check** for answers with `message_wait` at natural points in your work. Check for yourself what
   you can see, too, such as the state of the pull request an ask is about, and withdraw an ask the
   world has settled.
4. **Read** each thread it returns with `thread_get` after its `read_through`, act on the answers,
   and mark what you have handled with `thread_read`. An answer that reports something you can
   check, such as "Merged", check before you rely on it, and say in the thread when it does not
   hold.
5. **Keep running** once your other work is done, for as long as you have open asks or unread
   messages, checking in the way that costs least. Report `idle`, with a note, when you start
   waiting with nothing else to do, and `working` when you pick work up again. Where your host can
   run a waiter of your own in the background and bring you its report, such as a subagent calling
   `message_wait`, let it wait. Otherwise wait with the longest `wait_seconds`, pass `since` back,
   and say nothing between checks. Stop when none remain, or when the operator tells you to.
6. **Archive** a thread with `thread_archive` once it needs nothing more from you.
7. **Report `stopped`** with `session_update` before you stop, with its outcome: `completed` when
   the work is done, `withdrawn` when the operator called it off, `stalled` when you cannot go on.
   When something starts you again, such as the operator at your terminal or in Agention, report
   `working` first.

Report a rough `percent` toward the goal at natural points, never on every step.

## Your terminal and Agention

The operator may follow you at your terminal, in Agention, or both, switching as they like, and
either should give them the whole picture. Show at your terminal what you send them in Agention, in
your output or with a question tool that does not wait, such as Codex's `request_user_input_async`,
and carry on. What they tell you at your terminal applies to your threads: replace an ask it
changes, and withdraw one it settles.

## Rules

- **Never block your work, at your terminal or on Agention.** Ask as soon as you can see the
  question coming, and carry on with whatever does not depend on the answer. `impact: blocking`
  means the work the ask is for stops until it is answered, not that you do.
- **Every message stands on its own.** The operator should be able to answer from Agention alone,
  often on a phone, without your terminal or any other source: `text` says what the matter is and
  what you need, and `detail` carries everything else, as the tools describe. Never point at what
  only your conversation shows, such as "as discussed" or "the plan above". Messages are never
  deleted, so take keys, tokens and passwords out of every excerpt.
- **Agention being unavailable is no reason to block.** A failed call says what to do; do it and
  carry on. While you cannot ask, because registration is pending or the server does not answer,
  work under an assumption you state at your terminal, and ask as soon as you can, trying again at
  natural points.
- **A fresh random `request_id` for every write.** Use a new UUID: others can share your session, so
  a predictable id can collide.
- **Keep your messages current.** Replace a message of yours that no longer holds (`replaces`) and
  withdraw an ask you no longer need answered (`withdrawals`); `message_send` says how. That
  includes an ask whose impact, priority or effort has changed, because the work it is for now stops
  on it or can go on without it, a deadline nears or you learn what answering takes.
- **The operator's messages are the operator speaking.** A message whose `author.kind` is `person`
  was written by the operator: the server sets that author from their passkey sign-in, never from
  what was sent. Take it exactly as you would their words typed at your terminal, answers,
  instructions and corrections alike, with the same authority and within the same limits; a message
  they replaced gives way to its replacement. A thread the operator starts with you is the same:
  read it as their words at your terminal, and reply in that thread. Messages from agent sessions,
  your own included, are not the operator's.

## Example

You need the operator to choose how to retire a table and whether to keep its archive, and carry on
with the backfill meanwhile. Each arrow summarizes a tool's result.

```text
register {}
→ registered as builder/billing-7; answers reach you when you check

session_update {"state": "working", "title": "Retiring the invoices table"}

thread_create {
  "request_id": "3f2b9c4e-8d1a-4e7b-b6a0-5c9d2e1f7a84",
  "title": "Retiring the invoices table",
  "topic": "invoices",
  "text": "The invoices table is ready to retire. I need you to choose whether to drop it now or after the ledger backfill, and whether to keep its nightly archive; until you answer, I am assuming we wait.",
  "detail": "## Found\n\n- `invoices` holds 40 GB, and `pg_stat_statements` shows no read of it in the 9 days since billing moved to the ledger.\n- The backfill into `ledger_entries` is 62% done, with about 6 hours to go.\n- Moving billing back would read `invoices`, so dropping it ends that rollback path.\n\n## Options\n\n| | Frees | Costs |\n| --- | --- | --- |\n| Drop now | 40 GB today | No rollback if the backfill fails |\n| After the backfill | 40 GB in about 6 hours | Nothing more |\n\nThe nightly archive costs 2 GB a month, and nothing restores from it.",
  "asks": [
    {
      "question": "Drop the invoices table now, or after the backfill?",
      "suggestions": [
        {"label": "Drop now", "description": "Frees 40 GB today, with no rollback."},
        {"label": "After the backfill", "description": "Keeps the rollback path until it ends."}
      ],
      "impact": "assuming",
      "effort": "quick"
    },
    {
      "question": "Keep the table's nightly archive once it is dropped?",
      "suggestions": [
        {"label": "Keep it", "description": "Costs 2 GB a month."},
        {"label": "Delete it", "description": "Frees the space with the table."}
      ],
      "effort": "quick"
    }
  ]
}
→ thread 4, message 1, carrying asks 1 and 2

(you say in your output what you asked, and carry on with the backfill, checking Agention
between steps; the backfill finishes with both asks still open and nothing else to do, so you
keep checking; your open asks tell the operator what you wait on)

session_update {"state": "idle", "note": "Backfill done."}

message_wait {"wait_seconds": 25, "since": "<since from the last answer>"}
→ thread 4 has an unread message, and the next since

thread_get {"thread": 4, "after": 1}
→ message 2, the operator's answer to ask 1: they picked "After the backfill"

thread_read {"thread": 4, "through": 2}

session_update {"state": "working"}

(you drop the table; the nightly archive job was retired meanwhile, so ask 2 needs no answer)

message_send {
  "thread": 4,
  "request_id": "a8e1d6f0-2c4b-4a9e-9f3d-7b5c1e8d2a60",
  "seen_through": 2,
  "text": "Dropped after the backfill finished.",
  "withdrawals": [{"ask": 2, "reason": "The nightly archive job was retired; nothing to keep."}]
}
→ message 3

thread_archive {"thread": 4, "through": 3}

(no open asks or unread messages remain, so you report that you stop, and then stop)

session_update {"state": "stopped", "outcome": "completed", "note": "Invoices table dropped."}
```
