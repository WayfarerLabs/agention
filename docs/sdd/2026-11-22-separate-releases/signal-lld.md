# Separate releases: the plugin-is-behind signal LLD

- Status: Built in delivery 2 (agention#80)
- Date: 2026-11-22
- Requirements: [FRD](frd.md) U2, U3 and rulings 2 and 5; [HLA](hla.md) "The plugin-is-behind
  signal"; [plan](plan.md) delivery 2
- Code cited at 87f66b6, the delivery's base

This settles what the HLA leaves to delivery 2: the session column and when it is written, the
sessions read's new field, the web UI's notice and the bridge's register sentence. The agent
contract does not change: no agent route or field is added, and `agentApi.version`
(`packages/api/src/agent-api.ts:12`) is not bumped by this delivery.

## The column

Migration 9 adds `sessions.agent_api_version INTEGER CHECK (agent_api_version >= 1)`: the agent API
version stated on the session's latest approved call, null until its first one. It is appended to
`migrations` (`apps/server/src/database/migrations.ts:12`), never an edit of migration 1, where the
table is created (`migrations.ts:26-38`). An `ADD COLUMN` keeps every row and gives each null, so a
session that called before the upgrade is unmarked until it calls again, which a running session
does within its next tool call; nothing records what it stated before.

The test that freezes shipped migrations lists only migrations 1 and 2
(`apps/server/src/database/migrations.test.ts:8-13`), though 0.5.0 shipped seven
(`git show v0.5.0:apps/server/src/database/migrations.ts`). The delivery freezes 3 to 7 as they
shipped, in a commit of its own, so the append is checked against every shipped migration.

## When it is written

Every approved call on the agent mount already passes through `markSeen`
(`apps/server/src/store/presence.ts:18-29`): authenticated calls in the `/s/*` middleware
(`apps/server/src/http/agent-api.ts:81-91`) and `register` from a known key (`agent-api.ts:62-72`),
both through `seen`, which logs a failure and carries on (`agent-api.ts:38-48`). Its one `UPDATE`
stamps `last_seen_at` only when that moves it a minute or more, or when it is after now
(`presence.ts:21-27`), and only while the registration is approved.

`markSeen` takes the stated version too, and its one statement becomes:

```sql
UPDATE sessions SET
  last_seen_at = CASE WHEN <due> THEN :now ELSE last_seen_at END,
  agent_api_version = :version
WHERE id = (SELECT session_id FROM registrations WHERE id = :registration AND status = 'approved')
  AND (<due> OR agent_api_version IS NOT :version)
```

where `<due>` is today's throttle. So the version is written on any call that states a different
one, whatever the throttle says, and a call that changes neither writes nothing: the `WHERE` matches
no row, as a call within the minute does today, so the unchanged path costs no write and no extra
statement. The name `markSeen` stays true: it records the sighting, and what the session was seen
speaking is part of it.

The version is the one the mount's first middleware read. That middleware parses the header
(`apps/server/src/http/agent-api-version.ts:23-24`) through `agentApiVersion`, a missing header
reading as 1 (`packages/api/src/agent-api.ts:20-24`), and refuses anything outside `oldest` to
`version` before authentication (`agent-api-version.ts:28-42`). One new function there,
`statedAgentApiVersion(c)`, reads it for both the middleware and `seen`, so the version recorded is
the version checked. Only served versions reach `markSeen`, so the value fits an integer and is
passed as one.

A session that two bridges share (`apps/bridge/src/session.ts:64-67`) records whichever called last;
if they speak different versions, each change of speaker writes once. That is what the session's
state is, and the notice then shows while the older one is the latest to call.

## When a session is behind

A session is behind when it is live and `agent_api_version` is below `agentApi.version` (ruling 5).
Live is what the threads read already uses for stranded threads, less quiet: `threadsSeen`
(`apps/server/src/store/thread-reads.ts`) strands a thread whose session is quiet, has no approved
registration (`credential_active`) or whose latest status entry is `stopped`. `listSessions` already
reads both of the others for the page, the approved registrations it lists and the latest entry's
state, so a session is live when it has an approved registration among them and its state is not
`stopped`; no new query is needed. Quiet stays out: a working session that has not called for a
while goes quiet while still running, and the fix applies to it. A stopped or revoked session is not
marked, since restarting the session is no fix for one that is not running or cannot call. A stopped
one started again reports a state other than `stopped` (the usage skill has it report `working`
first), and a revoked one approved afresh holds an approved registration again; either is marked
again while still behind, with no code beyond the read. Null is not behind: a session with no
recorded call is not marked (HLA). Released bridges state 2 or 3, or, before 0.3.0, nothing, which
reads as 1, so every released bridge is covered (U2). The comparison is made where the summary is
built, in `listSessions`' `toSummary` (`apps/server/src/store/sessions.ts:373-400`), which selects
the column beside `last_seen_at` (`sessions.ts:290-294`). The server's own version is read there,
never stored, so after a server upgrade that moves it every session recorded at the old version that
is live is marked at once, before it calls again: the reason the HLA keeps a column.

## The sessions read

`sessionSummary` (`packages/server-api/src/sessions.ts:69-83`) gains `plugin_behind: boolean`,
always present, with a description in the generated document. Both mounts serve the read from one
declaration, `listSessions` in `apps/server/src/http/operator-operations.ts:143-151`, which the web
mount (`apps/server/src/http/web-api.ts:249`) and the operator mount
(`apps/server/src/http/operator-api.ts:55`) both add, so the field reaches the web UI and operator
API v1 together. A new response field is additive and stays in v1 (`docs/review-checklist.md` A19);
`docs/api/openapi.json` is regenerated.

Why `plugin_behind`:

- **It names what the operator acts on.** The fix is updating the plugin (U2), the operator installs
  plugins, never bridges, and each plugin release runs the bridge of its own version (R1), so a
  bridge that is behind is a plugin that is behind. The operator guide and the web UI say "plugin";
  a program the operator writes against the operator API shows the same notice in the same words.
- **The alternatives name the mechanism.** `agent_api_behind` reads as the server's own API being
  behind, and `bridge_behind` names a component no operator installs on its own.
- **A boolean, not the version.** U2 asks for the status. A recorded version would be a second
  public contract nothing reads yet, and could be added later as another additive field; the server
  is what knows its own version, so it, not each client, compares.
- **On the summary, not in `presence`.** `presence` lives in `packages/api`
  (`packages/server-api/src/sessions.ts:8`) because thread summaries carry it too, so a field there
  would change the agent line's shared package (R2) and every thread read; this status belongs to
  the session.
- **Always present**, as `presence.quiet` is, so a client tests one boolean.

The bridge's own tests read the sessions view as JSON (`apps/bridge/src/tools.test.ts:311-316`) with
`toMatchObject`, so they are unaffected.

## The web UI's notice

A behind session's row carries a notice, `<p className="notice warning">`, as a direct child of the
row's `li.session-row`, after its summary, where the row's other notices sit
(`apps/web/src/styles.css:2002-2004`) and in the tone of the warning the registration card gives
(`apps/web/src/views/sessions/Registrations.tsx:65-68`). It shows folded and unfolded, so the fix is
readable without unfolding the row. It says that the server offers features this session's Agention
plugin cannot use, and the fix: update the Agention plugin on this agent's host to its newest
release and restart the session. A current session's row shows nothing.

A chip among the row's facts, as **No credential** is
(`apps/web/src/views/sessions/SessionRow.tsx:180`), was rejected: the facts are a wrapping line of
short words, and the fix is a sentence the operator needs to act. The agent's header does not roll
it up: each session's plugin is the one on its own host, so the row is where the fix applies. The
text is fixed, with nothing from the server in it, so it is plain text (A9).

## The bridge's register sentence

The bridge reads the server's stated version on every answer, and refuses one older than its own
(`apps/bridge/src/agent-api.ts:380-391`, reading the header at `agent-api.ts:494-497`), but returns
only the body (`agent-api.ts:137-161`, `agent-api.ts:335-343`). `AgentApi` gains
`answered(key, request)`, which returns the body and the version the answer stated, which
`#requireVersion` has already accepted as at least the bridge's; `request` returns `answered`'s
body, so no other caller changes. `Session.#submit` (`apps/bridge/src/session.ts:186-206`) uses it
and returns the version beside the state.

`register` (`session.ts:80-110`) appends one sentence to its `message` when the version stated on
the answer it reports is above `agentApi.version`: the Agention server offers features this
session's plugin cannot use, so tell the operator at your terminal to update the Agention plugin on
this host to its newest release and restart this session, resuming it to keep this conversation, and
carry on meanwhile. It is added for every status, since a pending or refused session's agent also
relays to the operator, and it changes neither the answer's fields nor whether the call succeeds
(U3). The answer it reads is the last `#submit`, the one whose state `register` reports. A thread
tool's own registration check (`session.ts:117-132`) adds nothing: U3 places the signal at
registration.

The bridge compares only its own version with the one stated, never a release, so a bridge from this
delivery on relays the signal from any later server that bumps the agent API, which is what U3 asks;
earlier bridges write their register answers themselves and relay nothing new (U3).

## Tests

The suites model the bridge at HEAD, which states `agentApi.version` on every request, so their
agents do too, and a test that needs another version or none states it:

- The server's HTTP harness (`apps/server/src/http/test-harness.ts:186-199`) states the current
  version unless the request's headers give the header, a header given as `undefined` sending none;
  the two tests that mean no header (`apps/server/src/http/agent-api.test.ts:582-587`,
  `apps/server/src/http/agent-api-oldest.test.ts:32`) say so.
- The store fixture's `seen` (`apps/server/src/store/test-fixture.ts:171-174`) takes a version, the
  current by default.
- The browser tests' agent (`apps/web/e2e/agent.ts:21-56`), which calls "the way the agent bridge
  does", states the version it holds, the current by default.

The tests, at their boundaries, asserting fields, statuses and the notice's presence, never wording:

- **Store** (`presence.test.ts`): a missing header (1), an older version and the current one each
  recorded as stated; a session never seen not behind; a changed version written within the
  throttle's minute while `last_seen_at` holds; an unchanged version within the minute writing
  nothing (SQLite's `changes()` is 0); a revoked registration recording nothing; a behind session
  that reports `stopped` unmarked, and marked again once it reports `working`; and a behind session
  whose registration is revoked unmarked.
- **Migration** (`database.test.ts`): a database at migration 7 opens with every row intact and the
  new column null. The upgrade tests compared whole rows
  (`apps/server/src/database/database.test.ts:638-645`), which a migration adding a column breaks
  for every earlier test, so `earlier` compares each table on the columns its rows had before.
- **HTTP** (`web-api.test.ts`): the sessions read marks a session after a thread call stating an
  older version or none, and not after one stating the current, nor a session with no call recorded;
  and an approved key's registration stating an older version marks it, and one stating the current
  clears it, since `register` is the call that clears the notice after a plugin update. The web
  mount is read alone: both mounts serve the one declaration
  (`apps/server/src/http/operator-operations.ts:143-151`), and `operator-api.test.ts` proves the
  operator mount serves every operator operation.
- **Browser** (`apps/web/e2e/operator.spec.ts`): a session whose calls state an older version shows
  the notice on its row, another session none, and once its calls state the current version, the
  notice is gone.
- **Bridge** (`tools.test.ts`, beside the other version tests): the same register body answered
  stating the bridge's version and a newer one, pending, approved and rejected, succeeds both times
  with the same fields, and the newer answer's message is the other's with a sentence added, which
  also fails if the sentence appears at the bridge's own version.
- **Agent compatibility** (`apps/bridge/src/released-bridges.compat.ts`): after each released
  bridge's calls, while its session is live, its session's `plugin_behind` is whether the version
  its last request stated, none reading as 1, is below the server's, proving U2 for every released
  bridge; and once a release with `session_update` reports `stopped`, it is false.

## Permanent docs

- `docs/architecture.md` "Database" (the recorded version), "Store" (written on the seen path, when
  it is behind, the summary's field), "HTTP API" (the sessions read's field is additive in v1), "Web
  UI" (the notice) and "Agent bridge" (the register sentence).
- `docs/operator-guide.md` "Using the web UI", the sessions view: what the notice means and what to
  do.
- `docs/live-testing.md` "Surfaces": the notice in the sessions view, the field on both mounts and
  the register sentence.
