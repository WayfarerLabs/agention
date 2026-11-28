# Settled threads: High-Level Architecture

- Requirements: [FRD](frd.md); research: [prior art](prior-art-research.md); plan: [plan](plan.md)
- Status: The FRD is accepted with the operator's rulings, each open choice at its recommended
  answer; this HLA follows them. Line references are to `fix/scope-grants` at 0fc3252f, the top of
  the ready stack when this was written.

## Decisions at a glance

| Decision            | Choice                                                                                       | Why                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| What settles        | `settles: true` on a message, whose text is the reason                                       | FRD S1; the operator's "flag on a message"                              |
| Where it is offered | Sending a message, never starting a thread                                                   | FRD S4, by the schemas, and the database's check                        |
| Who may             | Either role; no role check                                                                   | FRD S3; review check A5 names it                                        |
| What Settled is     | The thread's latest message settles it                                                       | FRD S2, ruling 2; the latest message is always live, so one join        |
| Stored state        | One column on `messages`; nothing on `threads`                                               | Derived like status and topic; ADR 0001's append-only log               |
| Open asks           | Refused, inside the write, when any ask is open after the message                            | FRD S5, ruling 3                                                        |
| The filter          | `settled`: absent shows them, `only`, or `hide`; counts for each                             | FRD S9, ruling 5; shaped as `agent_read` is                             |
| Agents              | The next agent API version: `settles` on messages, `settled_by` on summaries; no list filter | FRD E1, S10; the contributing guide's rule for any agent contract field |
| Notifications       | Nothing new: a notifying view's `settled` filter is honored by the list's own SQL            | FRD S12                                                                 |
| The word            | "Settled" means only this; today's uses for asks' outcomes are renamed                       | FRD S14                                                                 |
| ADR 0001's limit    | A new decision record narrows it                                                             | FRD "What this changes in ADR 0001"                                     |

## Writing

### The part

`settles` is a new field of `messageFields` (`packages/api/src/threads.ts:324-335`), not of
`messageParts` (`:264-273`). `threadCreateInput` spreads `messageParts` (`:293-301`) and
`threadStartInput` lists its own fields (`:311-317`), so neither the agent's `thread_create` nor the
operator's thread start takes it, and a thread's first message cannot settle (S4) without a check of
its own. Both send inputs take it: `messageSendInput` (`:384`), which the operator mount serves to
the web UI and the operator API (`apps/server/src/http/operator-operations.ts:181`), and
`agentMessageSendInput` (`:392-396`), which the bridge's `message_send` builds on
(`apps/bridge/src/tools.ts:310-315`).

Its schema is `z.literal(true).optional()`: a message settles or says nothing about it, so there is
no `settles: false` to read two ways. In `partNames` (`:341-355`) it is `null`, as `detail` is: it
is no part alone. The refinement that refuses detail without text, `detailNeedsText` (`:278-289`),
also refuses a settling message without text, as `invalid_input` on `settles` (S1), and is renamed
for both, for example `needsText`. It already runs on every chain that takes the field:
`messageSendInput` (`:384`), `agentMessageSendInput` (`:392-396`), and the bridge's `message_send`
(`apps/bridge/src/tools.ts:310-315`), so the new rule needs no new call. A settling message is
therefore never a retraction, which the web UI tells by `carriesAPart`
(`apps/web/src/views/thread/Messages.tsx:772`).

There is no role check (S3). Review check A5 lists who owns which part ("Asks, withdrawals and
topics are the requester's, answers the audience's"); it gains "a settle either party's", so a later
reviewer reads the missing check as intended.

### Replacing and retracting

A replacement is a whole message (`checkParts`, `apps/server/src/store/threads.ts:378-483`), so it
settles only if it says so again, as it carries a topic only if it gives it again. A replacement and
a retraction each take the next sequence, so either becomes the thread's latest message: retracting
the settling message, or replacing an earlier message after settling, ends Settled unless that
message settles too. This is S2's rule applied, not an exception to it, and needs no code.

### Nothing left waiting

In `sendMessage`, once `appendMessage` has written the message with its asks, answers, and
withdrawals (`threads.ts:704-710`), a settling message reads `open_asks` for the thread. Any row
still there refuses the write as `invalid_input` on `settles`, naming the asks by number with
`numbered()` (`:371-374`), as the replacement rules already name asks, and saying what this writer
can do: withdrawing is the requester's, and answering or declining the audience's, so an agent reads
"asks 3 and 4 are open; withdraw them, in this message or before" and the operator "answer or
decline them". The transaction rolls the message back
(`apps/server/src/database/database.ts:71-89`). Checking after the write rather than before keeps
one source of truth: whatever the message itself answers, declines, withdraws, or asks again by
replacing is already counted by the view every other reader uses.

### Storage

A migration adds one column:

```sql
ALTER TABLE messages ADD COLUMN settles INTEGER NOT NULL DEFAULT 0
  CHECK (settles IN (0, 1) AND (settles = 0 OR (seq > 1 AND text IS NOT NULL)));
```

Beside the schemas, the database also holds S1's text and S4's first message: a settling row has
text and is never a thread's first. `messages` is append-only
(`apps/server/src/database/migrations.ts:207-214`), and existing rows take the default, so no
message written before this release settles. `appendMessage`
(`apps/server/src/store/threads.ts:212-233`) writes it, `Parts` (`:152-162`) carries it, and the
request digest (`:651-655`) covers it with the other parts, so a retry that differs only in
`settles` is a `request_id_conflict`. The migration's number is its position when it lands.

## Reading

### Derived state

The thread's latest message is the one at `threads.last_seq`, and it is always live, since only a
later message can replace it (`replaces_seq < seq`, `migrations.ts:198`). `threadsSeen`'s `base` CTE
already joins it (`apps/server/src/store/thread-reads.ts:132`), and takes the thread's `updated_at`
from it (`:119`), so it also selects that message's `settles` and author, and `toThreadSummary`
(`:316-366`) maps them to the summary. There is no second lookup.

`threadSummary` (`packages/api/src/threads.ts:552-572`) gains an optional `settled_by`, present only
while the thread is Settled, with the author in the shape a message's author already has. It needs
nothing more: the settling message is the latest, so its sequence is the summary's `last_seq` and
its time is `updated_at`. A message's read shape (`:471-488`) gains `settles: true` when it settles,
so the thread page marks the message, and its absence means it does not. Neither is stored beyond
the column above.

### The filter and counts

`listFilters` (`packages/api/src/thread-lists.ts:239-256`) gains `settled`, an optional enum of
`only` and `hide`, after `effort`, where the sheet offers it, after Status's ask filters, since the
list keeps the order the sheet offers its filters in (`:232-238`), and the address follows it.
Absent, the list shows Settled threads among the rest (ruling 5). It is shaped as `agent_read` is
(`:95-101`), and `include_archived` gives the words: the sheet offers **Show**, **Only**, and
**Hide**. `listParts` (`apps/server/src/store/thread-lists.ts:104-146`) gains its `keeps` over
`th.settled`, `parametersOf` (`:231-251`) its parameter, and `countThreads` (`:736-897`) counts
`{ any, only, hide }`, as it counts `agent_read` (`:864-867`).

What follows from the shared shape, with nothing per filter:

- The web UI's address reads and writes it from `threadsView`'s shape
  (`apps/web/src/router.tsx:89-121`).
- Saved views store it as part of the view (`packages/api/src/saved-views.ts:26-40`). A stored view
  without it reads as absent under `threadsView.strict()`
  (`apps/server/src/store/saved-views.ts:31-38`), so no stored view needs rewriting.
- **Act on every matching thread** reuses `threadFilters`
  (`packages/api/src/thread-lists.ts:623-638`), so the operator can read and archive every Settled
  thread at once.
- A notifying view, once notifications land, is checked through the same `listParts` (`threadKept`
  on `feat/notifications`), so a view with `settled: hide` stays quiet on a settle (S12). `settled`
  does not join notifications' `refusedFilters`: it is judged from the thread alone, like status.
- The agent's list builds on `listParts` with its own query (`thread-lists.ts:506-512`), so the new
  part, absent by default, changes nothing there. Agents get no filter (FRD S10 asks only for the
  summary).

## The agent API

The next agent API version, 8 at 0fc3252f (`packages/api/src/agent-api.ts:12`), adds `settles` to
`message_send` and to messages as read, and `settled_by` to summaries, with a constant beside
`summaryLinksAgentApiVersion` (`:25`). Other open pull requests also take the next version, so the
number is whichever is next when this lands. An `added[]` entry
(`apps/server/src/http/agent-api-version.ts:72-95`) leaves both out of answers to an older bridge:
from `messages`, from `error.missed`, and from `thread` and `threads`, as the entries for version
7's links do. An older bridge cannot settle, sees a settling message as its text, and ends Settled
by writing, as any message does (E1). `docs/architecture.md` "Versions of the APIs" lists what the
version adds, and `CONTRIBUTING.md` "The agent API", which names what the compatibility suite
drives, names the settle too.

The bridge needs no known-fields entry: it walks the tool's schema
(`apps/bridge/src/known-fields.ts:23-66`). `message_send`'s description (`tools.ts:292-309`) names
settling among the parts and says a replacement settles only if it says so again; `thread_list`'s
(`:368-374`) and `thread_get`'s (`:326`) name `settled_by` among the summary's fields. The settle's
reason is the message's text, which the answer cap already trims (`apps/bridge/src/fit.ts:88-105`).

The compatibility suite (`apps/bridge/src/released-bridges.compat.ts`) gains a
`takes("message_send", "settles")` case driving a settle, and its version-gated field check
(`:422-454`) expects `settles` and `settled_by` exactly at the new version and above.

## The web UI

- **Writing.** The composer (`apps/web/src/views/thread/Composer.tsx`) offers **Settle the thread**
  on a reply, never on a new thread. It sends `settles: true` with the box's text, which it then
  needs: `draftProblems` (`apps/web/src/views/thread/writer.ts:149-164`), which checks the draft
  alone, says so before sending. Open asks are the server's rule, not copied into the browser: a
  refusal naming them shows at the toggle through `failureAt` (`Composer.tsx:490-504`), with the
  draft kept, so the operator answers or declines them on their cards and sends again, in the same
  message.
- **Editing.** Editing a settling message, or changing the answers it gives, loads the toggle from
  the message as it loads the text, so the replacement settles unless the operator unchecks it.
  Without that, `keptParts` (`writer.ts:70-82`) would drop it and a typo fix would end Settled. It
  loads from the message only while that message is the thread's latest, so an edit of an older
  settling message does not settle again over a later reply.
- **The thread page.** A settling message's events line (`Messages.tsx:758-787`) reads **Settled the
  thread**, as the topic's line does. The head (`ThreadView.tsx:888-930`) shows **Settled** with who
  and when while the thread is Settled.
- **The list.** A Settled thread's row says so in words on the row, with who settled it, for example
  **Settled by you** or **Settled by billing-7**, since a phone shows no title; the row keeps its
  place (S7). Where on the row, among `.marks` (`ThreadRow.tsx:223-228`) with its words shown
  (`apps/web/src/icons.tsx:118-139`) or beside the session in `.where`, is the build's to choose
  against the narrowest phone. The filter sheet's **Settled** segment sits after Status's ask
  filters (Priority, Impact, Due, Effort), and its chip reads **Settled only** or **Settled hidden**
  (`FilterSheet.tsx`, `Chips.tsx`).
- **Clearing** is what exists: filter to Settled, select all, then **Read** and **Archive**, or act
  on every matching thread.
- **The word (S14).** `settledWords` (`apps/web/src/format.tsx:200-209`), which says a thread's asks
  were answered or withdrawn, is renamed for what it says, and so is the stylesheet's comment on
  `.thread-status`. The shipped guidance's uses of "settle" for an ask the world made unneeded
  (`apps/agent-plugin/skills/agention/SKILL.md:70`, `:125`, `:134`), the bridge's (`tools.ts:298`),
  the withdrawal reason's description (`packages/api/src/threads.ts:234`), and `docs/web-ui.md:361`
  say it another way, and so do the tests' fixtures that use "Settled" as a withdrawal reason or a
  message's text, which will sit beside tests of real settling. Promises that settle in code stay as
  they are.

## Audit

`messageResource` (`apps/server/src/audit/actions.ts:175-189`) records `settles` in every message's
data, true or false, as it writes every other key whether set or not, from `MessageEntry` (`:84-94`)
as `messageEntry` builds it (`apps/server/src/store/threads.ts:296-316`), so the log shows who
settled which thread and when (S13). The reason is message text, which the audit log never records.

## Agents' guidance

The usage skill (`apps/agent-plugin/skills/agention/SKILL.md`) gains S11's four points where they
act. "The model" (`:26-43`) defines Settled in one line. In "The loop", **Read** (acting on what a
thread brings) says that when someone else settles a thread of the agent's, it stops work on that
matter and archives the thread, replying only if a reply is needed, since a reply ends Settled; and
that when someone writes in a thread the agent settled, it acts on it, settling again only if the
matter is still over. **Archive** (`:87`) gains settling as the step before it when the matter is
over for everyone and not only for the agent, saying why, after withdrawing the asks it no longer
needs. "Pull requests and branches" (`:115-127`) names a merge as the commonest reason to settle,
and "Rules" says never to settle to drop a question still needed. The generated plugins are
regenerated.

## Security model additions

None to the trust model: settling is a message, with the message's authentication, roles, audit, and
rate budget. `SECURITY.md`'s **Roles** invariant gains that either party may settle.

## Testing

- Store: S2's rule, a later message from each role, a replacement with and without `settles`, a
  retraction, replacing an earlier message after settling, and settling again; S1's and S5's
  refusals, each role refused alike, with nothing written, and an ask answered, declined, or
  withdrawn in the settling message itself counting as resolved; the first message unable to carry
  it, by the schemas; the digest covering it; S10's `settled_by` on the summary, present only while
  Settled.
- Lists: the filter's three states and its counts, on the store and through the operator API's HTTP
  mount, and **act on every matching thread**; a saved view without it reading as before.
- HTTP: an older agent API version's answers without `settles` or `settled_by`; the OpenAPI parity
  test.
- Bridge: the compatibility suite against every released bridge.
- Web: the composer's toggle, its text rule, the server's refusal shown at it, and an edit keeping
  it; the events line, the head, the row's words, and the filter and its chip; browser tests of the
  row's words and the head, and of clearing Settled threads by the filter, select all, and read and
  archive, at a phone's width and side by side.

## Decision record

A new ADR, numbered when it lands, records Settled: a claim in a message, derived as status is,
undone by talking, with archive still each party's own, and amends ADR 0001's "Not doing" line that
a thread's status "only rolls up its asks and is no lifecycle" to say what Settled adds and why it
is not the rejected "items that open and close". Review check A5 changes with it, for the role. A6,
whose derived signals "inform and never trigger actions or block writes", needs nothing: Settled
blocks no write, and the open-asks refusal is a rule on a part keyed on open asks, as the
replacement rules already are.
