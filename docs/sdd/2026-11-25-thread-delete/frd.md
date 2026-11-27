# Deleting threads: Functional Requirements

- Status: Draft for the operator's review.
- Date: 2026-11-25
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim.
- Origin: the operator's direction in Agention, quoted under
  [The operator's direction](#the-operators-direction).
- Depends on: the thread list's multi-select with its mark actions, built as a separate effort.
  Deleting from the thread list (R1, R3) lands in its options menu and uses its bound on "every
  matching thread".

## Why this exists

Agention promises today that nothing is ever deleted (`SECURITY.md` "Security model"; ADR 0001
"Threads are append-only logs of messages, with asks"), and the agent skill tells agents to keep
keys, tokens and passwords out of messages for that reason
(`apps/agent-plugin/skills/agention/SKILL.md`, "Rules"). When a secret reaches a thread anyway,
pasted by the operator or quoted by an agent, nothing can take it out. Threads the operator no
longer wants also stay forever. The operator needs a way to delete a thread for good, and agents
need to understand what they meet when a thread they knew is gone.

## Who this is for

- **The operator**, who deletes threads, one or many at once, knowing it cannot be undone.
- **Agents**, which learn that a thread was deleted, and are told plainly what that means.
- **Programs using the operator API**, which delete threads only with a key the operator granted
  that power.

## The operator's direction

Verbatim, from Agention on 2026-11-25, items 4 to 8 of a request for multi-select in the thread
list:

<!-- markdownlint-disable MD029 -->

> 4. Once in the mode, an additional options menu pops up with "Mark read", "Mark unread", "Mark
>    read and archive", and "Delete" (in red).
> 5. Delete should offer a warning that data will be permanently deleted and cannot be recovered.
> 6. The only thing we keep for deleted threads should be the thread ID with a deleted marker. Files
>    should be purged as well.
> 7. The Agent API should give an appropriate response for trying to access a deleted thread and
>    agent instructions should mention it.
> 8. Delete is only available for the operator.

<!-- markdownlint-enable MD029 -->

In the same conversation the operator agreed to design Delete separately from the multi-select and
its mark actions, after the effort lead noted that it reverses the never-deleted promise, touches
the database's append-only rules, files, the agent API and the coming audit log, and that backups
keep deleted data until they rotate.

## Functional requirements

### Deleting

**R1. Delete in the multi-select menu.** The thread list's selection mode offers Delete in its
options menu, beside Mark read, Mark unread and Mark read and archive, shown in red. It acts on the
threads selected, or on every thread the list's filter matches when the operator chose that.

**R2. A warning first.** Delete deletes nothing until the operator confirms a warning that says how
many threads will be deleted, that everything in them will be permanently deleted, and that it
cannot be recovered. It also says that copies Agention does not hold, such as backups, are not
reached, and, until the server has rewritten the database once (R5), that content written before
this change may survive in the database's free space.

**R3. Only what the operator confirmed.** "Every matching thread" means the threads that matched
when the operator confirmed: a thread started afterwards is left out, and the operator is told. A
thread that received a message after it was selected is still deleted (Q4).

**R4. One thread at a time too.** _(Proposed; see Q1.)_ An open thread offers Delete as well, with
the same warning.

### What is deleted, and what is kept

**R5. Everything the thread held goes.** Deleting a thread removes its title, topic, messages
(replaced ones included), asks, answers, withdrawals, references, files and their contents, and
every read and archive mark on it. None of it can be found afterwards in Agention's database file or
the log beside it, its search and its free space included. For content written before this change,
that holds once the server has rewritten the database a single time, which it does by itself,
retries until done, and reports.

**R6. Only an identity and a marker stay.** A deleted thread keeps its number in its session, a
marker saying it was deleted, and when; Q6 settles whether anything else of its record stays. A
deleted thread's number is never given to another thread.

**R7. Gone from every view.** A deleted thread appears in no list, count, search, filter, wait or
"thread above and below". Opening a deleted thread, or following a link or a reference to one, says
that it was deleted, and nothing else.

### Who may delete

**R8. The operator alone.** The operator deletes from the web UI. A program deletes through the
operator API only with a key the operator granted deletion when creating it; a key created before
this change, and a key that may only write threads, cannot delete. No agent can delete anything.

### Agents

**R9. A clear answer for a deleted thread.** Every agent tool that names a deleted thread (reading
it, writing to it, marking it, archiving it, fetching or listing its files) fails with an answer of
its own that says the operator deleted the thread and everything in it, distinct from "not found". A
write that arrives after the delete is refused this way, and a file download under way stops. A new
message cannot reference a deleted thread.

**R10. Waiting agents learn of it.** An agent waiting for news is told which of its threads were
deleted, so one whose only open asks were in a deleted thread knows to stop waiting for them.

**R11. The skill explains it.** The agent skill and the tool descriptions say that the operator can
delete a thread, what an agent sees then, and what to do, as Q3 settles.

**R12. Released agents keep working.** Agents on any released bridge still work, and see the deleted
answer with its explanation.

### Saying what is kept and where copies live

**R13. The promise changes everywhere it is made.** The documentation, the skill and the tool
descriptions stop saying that messages and files are never deleted. They say instead that a thread
is kept until the operator deletes it, and still tell agents to keep secrets out of messages, since
copies outside Agention's database survive a delete.

**R14. Copies outside the database.** The operator guide says what a delete does not reach: backups
until they are replaced, files an agent fetched to its machine, what an agent's own conversation
holds, and files and drafts kept by the operator's browsers. It says how to take a deleted thread
out of backups: replace each one with a backup taken after the delete.

**R15. The audit trail.** When Agention keeps an audit log, it records that a thread was deleted, by
whom and when, and never anything the thread held.

## Out of scope

- A trash or undo: a delete is final from the moment it is confirmed.
- Deleting one message, a file alone, a session or an agent.
- Agents deleting anything, their own threads included.
- Deleting by age or by policy, without the operator choosing the threads.
- Reaching copies outside the database: backups, agents' machines and conversations, browsers.

## Definition of done

- R1 to R15 hold on `main`, each shown by tests at the level that proves it: store tests for what is
  removed and kept and for the database file holding no trace of the content, HTTP tests for the
  answers and the key's permission, the released-bridge compatibility suite for agents, and web and
  browser tests for the menus, the warning, the deleted page and the results.
- The architecture document, the operator guide, the security model, the review checklist, the API
  reference, an ADR recording the reversal of the never-deleted promise, and the agent skill
  describe deletion, with no reference to this SDD.

## Open questions for the operator

- **Q1. Delete on an open thread too (R4)?** Recommended: yes. Removing a pasted secret starts from
  the thread that shows it, and selecting it in the list first is a detour.
- **Q3. What should an agent do when its thread was deleted (R11)?** Recommended: take the thread's
  asks as withdrawn by the operator; never post again what the thread held; and start a new thread
  on the matter only when its work cannot go on without the operator, saying what it needs without
  repeating the deleted content.
- **Q4. Open asks and new messages (R3).** Recommended: delete regardless, both a thread with asks
  open to the operator and one that received a message after it was selected. Deleting is a
  deliberate choice, and an agent writing steadily to a thread must never be able to keep a pasted
  secret from being deleted. The other choice is to leave such a thread and say so.
- **Q5. How strong is the warning (R2)?** Recommended: a dialog that names the count and says the
  deletion is permanent, with Cancel first and focused and the red Delete button second, and nothing
  to type. Typing a word suits rarer actions than this, and is slow on a phone. The other choice is
  to require typing the count or "delete" for more than one thread.
- **Q6. What else stays of a deleted thread (R6)?** Its record also holds when it was started, how
  many messages it had, and its two parties, the session and you. Recommended: keep the parties,
  which say nothing the session's own name does not, and blank the start time to the deletion's and
  the message count to one, the most the database's rules allow without rebuilding the table. The
  other choice is to keep all three as they were.
- **Q7. The session's log (outside R5).** A session's status notes and outcomes are free text the
  agent wrote, and may mention what a deleted thread held. Recommended: leave the log untouched, as
  it is the session's record, not tied to one thread, and have the skill tell agents never to put a
  thread's content into a status note. The other choice is a way to delete a session's log entries
  too, which would be a design of its own.

Which keys may delete is settled rather than asked: a permission of its own, since review check A18
never lets an existing scope's meaning change, and R8 needs a writing key to stay unable to delete.

## Operator rulings, 2026-11-25 onward

None yet.
