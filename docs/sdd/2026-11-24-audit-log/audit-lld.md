# Audit log: P1 Low-Level Design

- Status: Following the accepted FRD and the HLA, which matches it; the lead's rulings and the
  reviews of 2026-11-26 are applied ([Rulings](#rulings)).
- Date: 2026-11-26
- Requirements: [FRD](frd.md) R1 to R17 and its rulings; architecture: [HLA](hla.md); research:
  [prior art](prior-art-research.md), whose sections 5 and 6 hold this design's evidence on OCSF
  versions and packaged collectors; plan item: P1 "Design", in [the plan](plan.md)
- Base: `main` at ef3439fc. `S/` is `apps/server/src/` and `A/` is `packages/api/src/`; every
  `file:line` is at that commit.
- Schema: the official `ocsf/ocsf-schema` repository at tag `1.9.0` (commit 856d462b), cited as
  `ocsf:` and a path in it.

This settles what the HLA leaves open for P1: each event's exact OCSF attributes, the failure codes,
coalescing, the migration, how the store records, the `serve` options, and how the file sink meets
packaged collectors. It designs nothing for P2's viewer or P3's OTLP sink beyond what P1's table
must already hold for them. Code and permanent docs written from it state behavior in their own
words, without requirement numbers or pointers here.

## Where the code goes

| Where                                         | Holds                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `S/audit/actions.ts` (new)                    | the action table: each action's class, activity, and input type                       |
| `S/audit/events.ts` (new)                     | the builder: typed inputs to the OCSF object, keys in a fixed order                   |
| `S/audit/record.ts` (new)                     | `recordAudit`, inside the caller's transaction, and `recordFailure`, in its own       |
| `S/audit/dispatcher.ts`, `S/audit/sinks/`     | the dispatcher and the stdout and file sinks (HLA "Dispatcher and sinks")             |
| `S/audit/retention.ts` (new)                  | pruning, run at start and with the upload sweep                                       |
| `S/http/origin.ts` (new)                      | `requestOrigin`, the peer address, user agent, method, and path of a request          |
| `S/identity.ts`                               | `Credential` and `Identity` gaining what an event needs; `checkCredential`'s refusals |
| `S/store/store.ts`                            | the store's audit wake, which the dispatcher listens to                               |
| `S/database/migrations.ts`                    | the audit migration, appended after the last on `main`                                |
| `S/http/operations.ts`                        | recording the refusals of a known key that reach an operation                         |
| `S/http/rates.ts`                             | `spendOnFailure` recording a failure once it has spent its budget                     |
| `S/errors.ts`                                 | an `ApiError` naming the key and code of a refusal the log records, never in its body |
| every mutating store function (table below)   | its `recordAudit` call                                                                |
| `S/cli.ts`                                    | the options, `agention audit forget-sink`, the usage text                             |
| `packages/private-files/src/private-files.ts` | a group-readable directory and file under the same rule                               |
| `apps/server/src/audit/fixtures/` (new)       | the pinned OCSF class schemas the tests validate against ([Testing](#testing-notes))  |

## The OCSF version

**Ruled by the lead on 2026-11-26: 1.9.0; move when a later phase needs a 1.10.0 attribute.** The
ruling came the day before 1.10.0 (tag `v1.10.0`, commit 2d209039) left the seven-day hold-back on
2026-11-27, on consumers' lag: every consumer that reads OCSF natively targets 1.5 or older, and
none reads either candidate ([prior art](prior-art-research.md), section 5). What 1.10.0 changes for
what P1 uses, comparing every file this design cites between the two tags on what validation reads
(requirements, enums, constraints, types), ignoring descriptions:

| Where                                             | 1.9.0                    | 1.10.0                                                  | Effect on P1                           |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------- | -------------------------------------- |
| `api_activity` `activity_id`                      | 1, 2, 3, 4 (and 0, 99)   | adds 5 List                                             | none: no List is recorded              |
| `iam` profiles                                    | `ai_operation`           | adds `physical_site`                                    | none: profiles are not applied         |
| `actor` `session`, `iam_role`                     | optional                 | recommended                                             | none: P1 sets `session` already        |
| `user` `account`                                  | optional                 | recommended                                             | none                                   |
| `network_endpoint` at-least-one                   | `ip`, `name`, `hostname` | adds `mac`                                              | none                                   |
| `metadata`                                        |                          | adds `received_time`, `log_facility`, `log_facility_id` | none                                   |
| `session`                                         |                          | adds `is_elevated`                                      | none                                   |
| dictionary `ip_t`                                 | at most 40 characters    | at most 45, and its regular expression escapes `.`      | none: addresses are normalized (below) |
| every other class, object, and attribute P1 names | as in 1.9.0              | unchanged on those terms                                |                                        |
| `metadata.version`                                | `"1.9.0"`                | `"1.10.0"`                                              | the one value that changes             |

Every sample event validates against both versions' class schemas, so moving later is the version
constant and the fixture files, and nothing in the builder.

## The schema P1 validates against

The class schemas without profiles. schema.ocsf.io's JSON Schema export applies every profile unless
asked not to, which makes `cloud` and `osint` required for API Activity; with `?profiles=` (empty)
it applies none, and is what the tests compile:
`https://schema.ocsf.io/schema/1.9.0/classes/api_activity?profiles=`, and the same for
`authentication` and `entity_management`, each a draft-07 JSON Schema with
`additionalProperties: false` on every object but `unmapped` and `data`. Their requirements agree
with the sources at the tag, which this design cites:

- `ocsf:events/application/api_activity.json` (6003: `actor`, `api`, `src_endpoint` required),
  extending `events/application/application.json` and `events/base_event.json`;
- `ocsf:events/iam/authentication.json` (3002: `user` required; `constraints.at_least_one` `service`
  or `dst_endpoint`) and `ocsf:events/iam/entity_management.json` (3004: `entity` required), each
  extending `events/iam/iam.json`;
- the objects `actor`, `user`, `session`, `api`, `service`, `metadata`, `product`, `reporter`,
  `network_endpoint` (through `endpoint`), `http_request`, `url`, `http_response`,
  `resource_details` (through `_resource`), `managed_entity`, `process`, `_entity`, and `object`,
  under `ocsf:objects/`, and `ocsf:dictionary.json` for types and enums.

The export does not check what the sources say in prose or in the dictionary's types: `type_uid` as
`class_uid * 100 + activity_id`, `ip_t`'s pattern and length, and `uuid_t`'s pattern. The builder's
tests check those three beside the schema ([Testing](#testing-notes)).

## The event

### Keys, in order

The builder writes every event's keys in this order, leaving out those that do not apply, and
nothing else. `JSON.stringify` keeps insertion order for keys that are not integers, which none is.

1. `class_uid`, `category_uid`, `activity_id`, `type_uid`, `class_name`, `activity_name`
2. `time`; for a coalesced failure `count`, `start_time`, `end_time`; then `severity_id`,
   `status_id`, and for a key's refusal `status_detail`
3. `metadata`: `version`, `product` (`name`, `vendor_name`, `version`), `reporter` (`uid`, then
   `name` once stored), `uid`, `sequence`, `log_name`, `event_code`
4. `actor`, when there is one
5. the class's own: for 6003 `api`, `resources`; for 3002 `user`, `session`, `service`,
   `auth_protocol_id`, `auth_protocol`, `is_mfa`; for 3004 `entity`
6. `src_endpoint`, then for a request `http_request` and, but for `activateApiKey`, `http_response`
7. `unmapped`: `credential`, and for a sign-in or link that ended sessions `ended_sessions`

### Base attributes

| Attribute             | Value                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `class_uid`           | 6003, 3002, or 3004, from the action table                                                               |
| `category_uid`        | 6 for 6003, 3 for 3002 and 3004                                                                          |
| `activity_id`         | from the action table                                                                                    |
| `type_uid`            | `class_uid * 100 + activity_id` (`ocsf:events/base_event.json`)                                          |
| `class_name`          | "API Activity", "Authentication", "Entity Management"                                                    |
| `activity_name`       | the activity's caption in the class, or for 99 Other the action's own label ("Reject")                   |
| `time`                | the store's clock when the transaction records it, epoch milliseconds                                    |
| `severity_id`         | 1 Informational for a success, 2 Low for a failure                                                       |
| `status_id`           | 1 Success, 2 Failure                                                                                     |
| `status_detail`       | a key's refusal's fixed code ([below](#failure-codes)); absent otherwise                                 |
| `metadata.version`    | `"1.9.0"`                                                                                                |
| `metadata.product`    | `{ "name": "Agention", "vendor_name": "Wayfarer Labs", "version": <the server's version> }`              |
| `metadata.reporter`   | `{ "uid": <the instance's id>, "name": <the server's name, once stored> }` ([below](#the-instance))      |
| `metadata.uid`        | `crypto.randomUUID()`, the row's `uid`                                                                   |
| `metadata.sequence`   | the row's `seq`                                                                                          |
| `metadata.log_name`   | `"audit"`                                                                                                |
| `metadata.event_code` | the action's stable name                                                                                 |
| `http_response.code`  | 200 for a success, the status the refusal answers for a failure (401 `unauthenticated`, 404 `not_found`) |

`metadata.event_code` is, in the metadata object, "The identifier of the original event. For example
the numerical Windows Event Code or Cisco syslog code." (`ocsf:objects/metadata.json`), and in the
dictionary "The `Event ID, Code, or Name` that the product uses to primarily identify the event."
(`ocsf:dictionary.json`). Agention's action name is exactly that, and it is the one field that names
the action in classes with no operation of their own. On 6003 it equals `api.operation`, except for
a scope refusal ([Failures after authentication](#failures-after-authentication)).

`http_response.code` is recorded only where it is the answer the caller gets. Every success is
answered 200 by the mounts (`S/http/operations.ts:177`, `S/http/web-api.ts`), and every refusal
recorded answers its error's status (`statusByErrorCode`, `S/http/app.ts:199`). `activateApiKey` is
recorded as the key authenticates, before the operation it is used for has run, so its answer is not
yet known and the event carries no `http_response`.

### The instance

Every event names the database it was recorded in, in `metadata.reporter`, "the entity from which
the event or finding was first reported" (`ocsf:objects/metadata.json`, recommended). `reporter`
(`ocsf:objects/reporter.json`, unchanged in 1.10.0) needs one of `hostname`, `ip`, `name`, or `uid`;
its `uid` is the instance's id, 16 random bytes in lowercase hexadecimal, and its `name` the
server's name once the first start to serve has stored it (`S/store/server-name.ts:22-32`), left out
before then, as in a `passkey-link` event recorded before the first serve. `metadata.product.uid`
would name the product, not the instance, and `metadata.loggers` describes a pipeline's stages, so
neither fits.

Sequences are per database, so the instance id lets a destination shared by several servers tell
their events apart, deduplicate within each, and detect gaps and rollbacks in each server's own
sequence (FRD R9). It is not secret: it opens nothing, and it says only which server wrote an event.

The migration makes it ([below](#the-migration)), once per database, rather than the first start:
`agention passkey-link` and `agention audit forget-sink` record events and can run before the first
serve, and the migration is the one step every opening of the database takes, so no event lacks the
id and no code path stores it. A restored backup keeps it, being the same instance; a copied data
directory started as a second server would share it, which is why the operator guide already gives a
second server a data directory of its own (`docs/operator-guide.md`, "Running the server").

### The actor and the credential

`actor` needs one of `user`, `session`, `process`, and the others `ocsf:objects/actor.json` lists.
`user` needs one of `account`, `name`, or `uid` (`ocsf:objects/user.json`). `session.credential_uid`
is current in 1.9.0; `user.credential_uid` is deprecated since 1.6.0 for
`user.programmatic_credentials`, so the credential sits in `actor.session` (AWS CloudTrail's access
key id maps there too).

| Credential           | `actor.user`                                                                                                                                                      | `actor.session`                                               | `unmapped.credential`                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| Browser session      | `uid` `person:<id>`, `name` the operator's, `type_id` 2 Admin                                                                                                     | `uid` `browser_session:<id>`, `credential_uid` `passkey:<id>` | `{ kind: "browser_session", id, passkey: { id, name } }` |
| API key              | the operator, as above                                                                                                                                            | `credential_uid` `api_key:<id>`                               | `{ kind: "api_key", id, name }`                          |
| Agent's registration | `uid` `session:<id>`, `name` `<agent>/<session>`, `type_id` 4 Service                                                                                             | `credential_uid` `registration:<id>`                          | `{ kind: "registration", id, agent, session }`           |
| A registration's key | none                                                                                                                                                              | `credential_uid` `registration:<id>`                          | `{ kind: "registration", id }`                           |
| Command line         | `uid` `os_user:<uid>`, `name` the OS user's name, `type_id` 99, `type` "OS user"; and `actor.process` `{ pid, name: "agention", cmd_line: "agention <command>" }` | none                                                          | `{ kind: "cli", command, os_user }`                      |
| None                 | no `actor`                                                                                                                                                        | none                                                          | `{ kind: "none" }`                                       |

- A browser session's `id` is the new non-secret column ([the migration](#the-migration)), 32
  lowercase hexadecimal characters; never its cookie or the cookie's hash (FRD R4).
- "A registration's key" is the agent `register` call that submits a new registration: the token was
  signed by the key it registers, which names no session yet, so the actor is the credential alone.
- `cmd_line` names the command, never its arguments: `agention passkey-link`,
  `agention audit forget-sink`. `os.userInfo()` gives the OS user's name and uid. `type_id` 99 with
  `type` "OS user", since the server cannot tell a person's account from a system account and 3
  System in OCSF means a machine account.
- The names in `unmapped.credential` (a key's, a passkey's) are read in the recording transaction,
  so they are the names at the time, and stay right after a rename.

### Where the request came from

| Attribute                  | Value                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src_endpoint.ip`          | the connection's peer address, when it is known and fits `ip_t`                                                                                 |
| `src_endpoint.name`        | `"unknown"`, only when the request has no usable peer address                                                                                   |
| `src_endpoint.hostname`    | for a command-line event, `os.hostname()`, the host the command ran on                                                                          |
| `http_request.http_method` | the request's method: `POST`, or `GET` or `HEAD` for a refused read or a key's first use                                                        |
| `http_request.url.path`    | for a success, the routed path, whose parameters the operation's schemas accepted; for a failure, the matched route pattern (`c.req.routePath`) |
| `http_request.user_agent`  | the `User-Agent` header, cut to 256 UTF-16 code units without splitting a surrogate pair, when present                                          |

- `network_endpoint` needs one of `ip`, `name`, `hostname`, and the others
  `ocsf:objects/network_endpoint.json` lists, so an empty `src_endpoint` would fail the schema; 6003
  requires `src_endpoint`, so every event carries one that names something.
- The peer is read as `(c.env as HttpBindings | undefined)?.incoming?.socket.remoteAddress`, as
  `addOperations` reads the outgoing side (`S/http/operations.ts:160-162`); an in-process
  `app.request` has no `incoming`. An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`, what a
  dual-stack socket reports) is written as its IPv4 form, and an address `net.isIP` refuses or
  longer than 40 characters is left out, so `ip` always fits 1.9.0's `ip_t`.
- A `GET` route answers `HEAD` too (`S/http/operations.ts:143`), so a refused `HEAD` is written as
  `HEAD`, the method the request used; `activateApiKey` records whichever request first used the
  key.
- **A failure's path is its route, never its text.** A failure is recorded before, or instead of,
  any schema reading the path, so its raw path is whatever the client sent. `c.req.routePath`, read
  in the route's handler where every recorded failure is caught, is the pattern the server declared
  with the mount's prefix, such as `/api/operator/v1/s/:agent/:session/threads/:thread/messages`
  (checked with Hono 4.13.19, the locked version). The user agent, bounded, stays the only string a
  client chooses that reaches an event.
- Command-line events carry no `http_request`.

### Resources and entities

6003 lists what it acted on in `resources`, each `resource_details` with `type`, `uid`, a `name`
where one exists, and `data` for its details (`ocsf:objects/resource_details.json`, needing `name`
or `uid`). 3004 names its one `entity`, a `managed_entity` with `uid`, `name`, `type_id` 99 Other
and `type` the kind, and `data` (`ocsf:objects/managed_entity.json`); the operator, when a passkey
link creates them, is `type_id` 2 User with `user`. Each describes the thing as it stands after the
action, with what it was in `data.previous_name` for a rename; a deletion describes it as it was.
`entity_result` is deprecated since 1.9.0 for `updated_entity`, which is new in 1.9.0, so neither is
used: older consumers know `entity` and `data`.

| Kind           | `uid`                       | `name`                                        |
| -------------- | --------------------------- | --------------------------------------------- |
| session        | `session:<id>`              | `<agent>/<session>`                           |
| agent          | `agent:<id>`                | `<agent>`                                     |
| thread         | `thread:<id>`               | `<agent>/<session>/<number>`                  |
| message        | `message:<thread id>/<seq>` | `<agent>/<session>/<number>/<seq>`            |
| file           | `file:<id>`                 | none (FRD R5)                                 |
| group          | `group:<id>`                | the group's name                              |
| tag            | `tag:<name>`                | the tag's name                                |
| voice settings | `voice_settings`            | none                                          |
| audit sink     | `audit_sink:<kind>`         | the kind                                      |
| API key        | `api_key:<id>`              | the key's name                                |
| passkey        | `passkey:<id>`              | the passkey's name                            |
| registration   | `registration:<id>`         | `<agent>/<session>`, granted or else proposed |
| passkey link   | none                        | `"passkey link"`                              |
| the operator   | `person:<id>`               | the operator's name                           |

- A tag has no id: tags are keyed by name (`S/database/migrations.ts:615-619`), so a tag's `uid`
  changes when it is renamed. `renameTag`'s event names the tag by its new name, with the old in
  `data.previous_name`, which is how a consumer follows a tag across a rename.
- A thread is never named by its title, nor a file by its name (FRD R5). A passkey link has no
  identifier but its token's hash, which is derived from a secret, so it has none in an event.

### Service, for Authentication

3002 requires `service` or `dst_endpoint` (`ocsf:events/iam/authentication.json`, `constraints`).
Every 3002 event carries `service: { name: <the server's name>, uid: <the server's origin> }`, the
service signed in to. Logons add `auth_protocol_id` 99 Other with `auth_protocol` `"WebAuthn"` for a
passkey or `"API key"` for a key, and a passkey's successful logon `is_mfa: true`, since every
ceremony requires user verification (`S/auth/passkeys.ts:174`, `:317`).

## The actions

Every action, its class and activity, and what it names.

### Writes: API Activity 6003

| Action (`api.operation`) | Activity | Mounts        | `resources` and their `data`                                                              |
| ------------------------ | -------- | ------------- | ----------------------------------------------------------------------------------------- |
| `createThread`           | 1 Create | agent         | the session; the thread; its first message                                                |
| `startThread`            | 1 Create | web, operator | the session; the thread; its first message                                                |
| `sendMessage`            | 1 Create | all three     | the thread; the message                                                                   |
| `archiveThread`          | 3 Update | all three     | the thread, `data.through`                                                                |
| `bulkArchive`            | 3 Update | web, operator | each thread archived, `data.through`                                                      |
| `actOnThreads`           | 3 Update | web, operator | each thread archived, `data.through`; each message of declines written                    |
| `actOnMatchingThreads`   | 3 Update | web, operator | as `actOnThreads`                                                                         |
| `uploadFile`             | 1 Create | all three     | the file, `data` `{ size, media_type, session }`                                          |
| `removeUpload`           | 4 Delete | all three     | the file                                                                                  |
| `createGroup`            | 1 Create | web, operator | the group, `data` `{ color, position }`                                                   |
| `renameGroup`            | 3 Update | web, operator | the group, `data.previous_name`                                                           |
| `recolorGroup`           | 3 Update | web, operator | the group, `data.color`                                                                   |
| `orderGroups`            | 3 Update | web, operator | each group, `data.position`                                                               |
| `removeGroup`            | 4 Delete | web, operator | the group, `data.sessions`, how many it held                                              |
| `createTag`              | 1 Create | web, operator | the tag, `data.color`                                                                     |
| `renameTag`              | 3 Update | web, operator | the tag by its new name, `data.previous_name`                                             |
| `recolorTag`             | 3 Update | web, operator | the tag, `data.color`                                                                     |
| `removeTag`              | 4 Delete | web, operator | the tag                                                                                   |
| `setSessionGroup`        | 3 Update | web, operator | the session, `data.group` (`group:<id>` or null)                                          |
| `setSessionTags`         | 3 Update | web, operator | the session, `data` `{ tags, created_tags }`                                              |
| `setAgentTags`           | 3 Update | web, operator | the agent, `data` `{ tags, created_tags }`                                                |
| `updateSession`          | 1 Create | agent         | the session, `data` `{ update, state, outcome, percent }`                                 |
| `setVoiceSettings`       | 3 Update | web           | voice settings, `data.changed`: which of `base_url`, `model`, `prompt`, `api_key` changed |
| `clearVoiceSettings`     | 4 Delete | web           | voice settings                                                                            |
| `forgetSink`             | 4 Delete | command line  | the audit sink, `data.delivered_seq`                                                      |

- A message's `data` is `{ asks, answers, declined, withdrawals, files, replaces, status }`: the
  numbers of the asks it puts, answers, declines, and withdraws, the `file:<id>` of each file it
  carries, the message it replaces, and for an agent's write the state and outcome it reports. Never
  text, a title, a note, a question, a suggestion, an answer's words, a reference's text, or a
  link's URL. `createThread` names the session, the thread, and the message in that order.
- `actOnThreads` and `actOnMatchingThreads` with `action` `read` or `unread` are read marks and
  record nothing (FRD R1). With an archiving action they record one event for the call, listing each
  thread they archived and each message of declines they wrote, the latter with `data.declined`.
- `updateSession`'s `data` leaves out the title, the goal, and the note, which the session writes
  and which may carry the substance of its work, as a thread's title may. An agent write's status
  report rides in its message's `data.status`, and the entry that marks an idle session working
  (`statusOnWrite`, `S/store/sessions.ts:194-215`) is part of that write.
- `api.service.name` is `web`, `operator/v1`, `agent`, or `cli`.

### Sign-ins: Authentication 3002

| Action                       | Activity | Credential              | `user`, `session`, and what it ended                                                                                                                           |
| ---------------------------- | -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signIn`                     | 1 Logon  | the new browser session | the operator; the new session's `{ uid, credential_uid, created_time, expiration_time }`; the session it replaced on this browser in `unmapped.ended_sessions` |
| `signIn`, failed             | 1 Logon  | none                    | `{ name: "unknown", type_id: 0 }`; no session                                                                                                                  |
| `usePasskeyLink`             | 1 Logon  | the new browser session | as `signIn`, with every session the link ended in `unmapped.ended_sessions`                                                                                    |
| `usePasskeyLink`, failed     | 1 Logon  | none                    | as a failed `signIn`                                                                                                                                           |
| `signOut`                    | 2 Logoff | the session signing out | the operator; the session                                                                                                                                      |
| `authenticateApiKey`, failed | 1 Logon  | the key                 | the operator, the key's owner; no session                                                                                                                      |

- `expiration_time` is the session's absolute expiry; its idle expiry moves with use.
- A failed sign-in has no actor (FRD R2). The schema requires `user`; `name` `"unknown"` with
  `type_id` 0 Unknown meets `user`'s at-least-one with no uid. The passkey a failed sign-in
  presented is not named: its credential id is the client's claim, which an attacker can replay. Nor
  is its reason: every failed sign-in or link answers the same `unauthenticated`, and the event
  records that one did, how many, and from where.
- Sessions that end as another action's effect are named in that action's event, by `uid`
  `browser_session:<id>`, and record no event of their own: a sign-in on a browser that held one
  (`S/auth/passkeys.ts:202`) and a passkey link (`unmapped.ended_sessions` on the Logon), and a
  passkey's removal, whose cascade ends the sessions it signed in
  (`browser_sessions.passkey_id ... ON DELETE CASCADE`, `S/database/migrations.ts:108`), in its
  entity's `data.ended_sessions`. The store reads those sessions before the deletion that ends them.

### Credentials and registrations: Entity Management 3004

| Action                | Activity    | `entity` and its `data`                                                          |
| --------------------- | ----------- | -------------------------------------------------------------------------------- |
| `createApiKey`        | 1 Create    | the key, `data` `{ scopes, expiration_time }` (null for none)                    |
| `revokeApiKey`        | 9 Disable   | the key, by the operator or by a passkey link                                    |
| `activateApiKey`      | 10 Activate | the key: its first use                                                           |
| `addPasskey`          | 1 Create    | the passkey, added on a signed-in browser or by a passkey link                   |
| `renamePasskey`       | 3 Update    | the passkey, `data.previous_name`                                                |
| `removePasskey`       | 4 Delete    | the passkey, `data.ended_sessions`                                               |
| `replacePasskey`      | 4 Delete    | each passkey a passkey link replaces                                             |
| `createOperator`      | 1 Create    | the operator, `type_id` 2 User, when the first link creates them                 |
| `register`            | 1 Create    | the registration, `data` `{ proposed_agent, proposed_session, expiration_time }` |
| `approveRegistration` | 6 Enroll    | the registration, `data` `{ session, new_agent, new_session, group, tags }`      |
| `rejectRegistration`  | 99 "Reject" | the registration                                                                 |
| `revokeRegistration`  | 9 Disable   | the registration                                                                 |
| `issuePasskeyLink`    | 1 Create    | the link, `data` `{ expiration_time, replaces_passkeys }`, from the command line |

- `register` records only a new registration. A known key's call reports its state and writes
  nothing (`S/store/registrations.ts:136-139`), so it records nothing.
- `issuePasskeyLink` revokes every unused link as it issues one (`S/auth/passkey-links.ts:25`); that
  is part of issuing, as the link's description says, and records nothing of its own.
- `activateApiKey` is OCSF's Activate, "a change of state of the engine"
  (`ocsf:events/iam/entity_management.json`); its name says the key's first use, which is all it
  records. Later uses record only the writes they make (FRD R3).

**A passkey link's effects.** `finishLink`'s one transaction (`S/auth/passkeys.ts:426-457`) records,
in this order: the `usePasskeyLink` Logon; then for a replacement a `replacePasskey` for each old
passkey and a `revokeApiKey` for each live key it revokes, or for the first link `createOperator`;
then `addPasskey` for the new passkey. No field links them, as the FRD asks for none: they share the
new browser session as their credential, the same `time`, and the same `http_request`, and they are
consecutive in the sequence, so a consumer finds a link's effects by its session.

### Failures after authentication

| Action               | Class, activity                                | Credential | `status_detail`              | Refused at                                                                                                                  |
| -------------------- | ---------------------------------------------- | ---------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `authorizeScope`     | 6003, the refused operation's activity (below) | the key    | `scope`                      | the mount (`S/http/operations.ts:153-155`); `approveRegistration` with a group or tags (`S/store/registrations.ts:281-282`) |
| `authenticateApiKey` | 3002 Logon                                     | the key    | `key_revoked`, `key_expired` | authentication (`S/auth/api-keys.ts:212-214`); an operation's own check (`S/identity.ts:99-108`)                            |

- A scope refusal's `api.operation` is the operation refused, and its action, in
  `metadata.event_code` and the table, is `authorizeScope`, the step that failed. Its activity is 2
  Read for a `GET`, the action table's activity for a `POST` whose action is a 6003 one, and 3
  Update for any other `POST`: the registration decisions, whose own events are 3004, and the read
  marks.
- **Refused inside the store.** Two refusals of a known key come from a store function, inside its
  transaction, which rolls back: `approveRegistration` refusing a group or tags to an identity
  without `sessions:write` (`S/store/registrations.ts:281-282`), and `checkCredential` refusing a
  key revoked or expired since the request authenticated, as a long poll's key can be
  (`S/identity.ts:99-108`). Each is recorded with `recordFailure` once the rollback is done, as the
  same kind as the mount's (a scope refusal; a key revoked or expired), and the caller's answer is
  unchanged. `checkCredential` reads the key's `revoked_at` and `expires_at` to name the code; a row
  already deleted as dead (`deleteDead`, `S/auth/api-keys.ts:74-78`) no longer says which, and its
  refusal records nothing.
- Only an API key is ever refused for scope: a browser session holds every scope, and an agent's
  registration holds `threads:write` (`S/identity.ts:55`), which every agent operation requires or
  includes (`A/scopes.ts:28-34`).

### Not recorded

As the HLA lists: the read marks, every `GET`, transcriptions, and the housekeeping each function in
[the map](#the-map-at-ef3439fc) marks none, such as expiry deletions, idle extensions, a key's
hourly `last_used_at`, a session's `last_seen_at`, the upload sweep, and the server's name stored at
its first start; and failed agent authentication, which the FRD does not ask for.

A call also records nothing when its store function returns before it writes: a replayed write,
which answers its first result (`S/store/threads.ts:503-506`, `:607-610`); a status update that
changes nothing (`S/store/sessions.ts:125-127`); `renameTag` to its own name
(`S/store/groups-and-tags.ts:256-258`); and a bulk archive or archiving action that archives no
thread.

## Failure codes

`status_detail` holds one of these on a key's refusal, fixed and lower case, never the refusal's
message. Failed sign-ins and links carry none ([above](#sign-ins-authentication-3002)).

| Code          | Action               | When                                                                  |
| ------------- | -------------------- | --------------------------------------------------------------------- |
| `key_revoked` | `authenticateApiKey` | a key the server found by its hash is revoked                         |
| `key_expired` | `authenticateApiKey` | a key the server found by its hash expired, unrevoked                 |
| `scope`       | `authorizeScope`     | a live key lacks the scope the operation, or part of its input, needs |

The error carries them: `apiKeyUnauthenticated` and `notFound` take an optional `{ key, code }` that
`ApiError` keeps beside its own code and never puts in `toBody` (`S/errors.ts:23-32`). A missing,
malformed, or unknown key carries none, and records nothing (FRD R1).

## Coalescing

Anyone who can reach the server can cause failures, and the rate budgets bound their CPU, not their
storage (HLA). So every failure event is coalesced:

- **Its kind** is its action, its credential, and its `status_detail`: `signIn` and `usePasskeyLink`
  with neither, `authenticateApiKey` with each key and `key_revoked` or `key_expired`, and
  `authorizeScope` with each key and `scope`. A key's revoked and expired refusals never fold
  together. A coalesced event's `src_endpoint`, `http_request`, and for a scope refusal
  `api.operation` and activity, are its first failure's, as its origin is (FRD R2).
- **Its minute** is the UTC minute of its first failure: `open_until` is the end of that minute,
  `(floor(time / 60000) + 1) * 60000`.
- **The first failure** of a kind in a minute inserts an event with `count` 1, `start_time` and
  `end_time` its `time`, and `open_until` set.
- **A later failure** of that kind while `open_until` is after the store's clock rebuilds the
  event's JSON with `count` one higher and `end_time` its time, and updates the row: `JSON.parse`,
  set the two fields, `JSON.stringify`, which keeps every other byte, key order included. The update
  trigger allows exactly that ([below](#the-migration)).
- **Once the minute ends** the event is final. The next failure of the kind opens a new one.

**`start_time` and `end_time` at a count of 1** depart from `ocsf:events/base_event.json`, which
asks them only of an aggregate with `count` above 1 and says not to populate them for a discrete
event. A failure event is open to more for its minute, and the update trigger lets an update change
only `count` and `end_time`, in place, so both must exist from the insert; and whether an event
stays at 1 is known only once its minute has ended, after which it never changes. So every failure
event carries its window, and `time` equals `start_time`, as the same file asks of an aggregate.

**The lookup** reads the open events through their own index, which holds only failures, of which at
most one per kind is open:

```sql
SELECT seq, event FROM audit_events INDEXED BY audit_events_open
WHERE open_until > :now AND action = :action AND credential_kind = :kind
  AND credential_id IS :id AND json_extract(event, '$.status_detail') IS :detail
```

**The bound.** One event per kind per minute, whatever the rate. The two kinds without a credential
come to 2,880 a day at most. Each key adds about 1,440 a day for each kind it is refused for all
day, and a key is refused one way at a time: as revoked, as expired, or, while live, for scope. The
budgets alone would admit 14,400 failed sign-ins and 86,400 failed key checks a day
(`S/http/rates.ts:39-47`). The bound grows with each key refused, which the FRD's estimate of "a few
thousand" a day (R2) does not anticipate; the keys that can be refused are only those whose secret
someone holds, at most 20 live (`A/api-keys.ts:12`) and the revoked or expired ones not yet deleted.

**When a failure is recorded.** In a transaction of its own, after the failure has spent its budget
or, inside the store, after its transaction rolled back, with the answer unchanged:

- `spendOnFailure(budget, attempt, record)` (`S/http/rates.ts:164-173`) gains `record`, called with
  the error after `this.spend(budget)` returned, so a request refused because the budget is spent
  records nothing. The web mount passes one for `failedSignIn` and `failedLink`
  (`S/http/web-api.ts:162`, `:171`, `:179`), which records every `unauthenticated` it is given, and
  the operator mount one for `failedKeyAuth` (`S/http/operator-api.ts:167-169`), which records only
  an error naming a key.
- `addOperations` (`S/http/operations.ts:144-180`) catches, around everything after `authenticate`
  returns (the scope check at `:153-155`, the input, and the handler), an `ApiError` naming a key,
  records it, and rethrows it. That holds the mount's scope refusal and both refusals inside the
  store, all within the key's own budget, which `authenticate` spent first
  (`S/http/operator-api.ts:170`). `authenticate`'s own refusals are outside it, so none is recorded
  twice.
- A failure that cannot be recorded, such as on a busy or full database, is written to the server's
  log, at most once a minute, as `markSeen`'s failures are (`S/http/agent-api.ts:38-53`); the
  request is still refused as before. There is no write for it to weaken.

**The dispatcher holds an open event.** A sink's batch is the events after its cursor and before the
first still open by the store's clock, so a count is final when it leaves and sinks receive in
order. An open failure delays the events after it by at most its minute.

## The migration

Appended after the last migration on `main` when it lands, whatever number that makes it (ten are
frozen at ef3439fc, `S/database/migrations.ts:13-681`), with its hash added to `frozen` in
`S/database/migrations.test.ts:11` in the same change. It runs in one transaction with the version
bump (`S/database/database.ts:128-161`), so it applies or rolls back whole.

```sql
-- The audit log: one row per event, in the order events were recorded. seq
-- is the event's place in that order and its metadata.sequence; AUTOINCREMENT
-- never reuses one, even once pruning empties the table, and each event takes
-- the next. uid is its metadata.uid, a random UUID. event is the OCSF object
-- as the builder wrote it; the other columns copy its fields for filtering.
-- credential_id is the credential's id as text, null for the command line and
-- for no credential. open_until marks a coalesced failure: until then later
-- failures of its kind raise its count, and no sink receives it.
CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE CHECK (length(uid) = 36),
  time INTEGER NOT NULL,
  class_uid INTEGER NOT NULL CHECK (class_uid IN (3002, 3004, 6003)),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  credential_kind TEXT NOT NULL
    CHECK (credential_kind IN ('browser_session', 'api_key', 'registration', 'cli', 'none')),
  credential_id TEXT
    CHECK ((credential_id IS NULL) = (credential_kind IN ('cli', 'none'))),
  event TEXT NOT NULL CHECK (json_valid(event) AND json_type(event) = 'object'),
  open_until INTEGER CHECK (open_until IS NULL OR (outcome = 'failure' AND open_until > time))
) STRICT;
-- The coalesced failures, by the end of their minute: the open ones, which
-- coalescing looks up and delivery stops before.
CREATE INDEX audit_events_open ON audit_events (open_until) WHERE open_until IS NOT NULL;

-- Each event takes the next sequence, and carries its own seq and uid.
CREATE TRIGGER audit_events_in_order BEFORE INSERT ON audit_events
WHEN new.seq IS NOT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'), 0) + 1
  OR json_extract(new.event, '$.metadata.sequence') IS NOT new.seq
  OR json_extract(new.event, '$.metadata.uid') IS NOT new.uid
BEGIN
  SELECT RAISE(ABORT, 'an audit event takes the next sequence and carries its seq and uid');
END;

-- An event never changes, but for an open coalesced failure, which no sink
-- has received: its count rises and its end_time moves on, within its
-- minute, both staying integers, and nothing else changes.
CREATE TRIGGER audit_events_fixed BEFORE UPDATE ON audit_events
WHEN old.open_until IS NULL
  OR EXISTS (SELECT 1 FROM audit_sinks WHERE delivered_seq >= old.seq)
  OR new.seq IS NOT old.seq OR new.uid IS NOT old.uid OR new.time IS NOT old.time
  OR new.class_uid IS NOT old.class_uid OR new.action IS NOT old.action
  OR new.outcome IS NOT old.outcome OR new.credential_kind IS NOT old.credential_kind
  OR new.credential_id IS NOT old.credential_id OR new.open_until IS NOT old.open_until
  OR json_type(new.event, '$.count') IS NOT 'integer'
  OR json_type(new.event, '$.end_time') IS NOT 'integer'
  OR json_remove(new.event, '$.count', '$.end_time')
    IS NOT json_remove(old.event, '$.count', '$.end_time')
  OR json_extract(new.event, '$.count') <= json_extract(old.event, '$.count')
  OR json_extract(new.event, '$.end_time') < json_extract(old.event, '$.end_time')
  OR json_extract(new.event, '$.end_time') >= old.open_until
BEGIN
  SELECT RAISE(ABORT, 'an audit event changes only as an open failure counts another');
END;

-- Only the oldest event is ever removed, and only once every sink has it.
CREATE TRIGGER audit_events_pruned_in_order BEFORE DELETE ON audit_events
WHEN old.seq IS NOT (SELECT min(seq) FROM audit_events)
  OR EXISTS (SELECT 1 FROM audit_sinks WHERE delivered_seq < old.seq)
BEGIN
  SELECT RAISE(ABORT, 'only the oldest audit event is removed, once every sink has it');
END;

-- Each sink's cursor: the kind it is configured as, which names it, and the
-- last sequence it delivered, which only moves forward. A sink's row stays
-- when the sink is no longer configured, so retention waits for it, until
-- agention audit forget-sink removes it.
CREATE TABLE audit_sinks (
  name TEXT PRIMARY KEY CHECK (name IN ('stdout', 'file')),
  delivered_seq INTEGER NOT NULL CHECK (delivered_seq >= 0),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TRIGGER audit_sinks_forward BEFORE UPDATE OF delivered_seq ON audit_sinks
WHEN new.delivered_seq < old.delivered_seq
BEGIN
  SELECT RAISE(ABORT, 'a sink''s cursor only moves forward');
END;

-- This instance's id: random and not secret, made once with this migration
-- and never changed after, which every audit event carries so a destination
-- shared by several servers tells them apart.
ALTER TABLE instance ADD COLUMN uid TEXT
  CHECK (uid IS NULL OR (length(uid) = 32 AND uid NOT GLOB '*[^0-9a-f]*'));
UPDATE instance SET uid = lower(hex(randomblob(16)));
CREATE TRIGGER instance_uid_fixed BEFORE UPDATE OF uid ON instance
WHEN old.uid IS NOT NULL AND new.uid IS NOT old.uid
BEGIN
  SELECT RAISE(ABORT, 'a server''s instance id never changes');
END;

-- A browser session's id: random and not secret, so the audit log can name
-- the session without its cookie or anything derived from it. The table is
-- rebuilt to hold it as a constrained column, and each session open now gets
-- one.
CREATE TABLE browser_sessions_with_ids (
  hash BLOB PRIMARY KEY CHECK (length(hash) = 32),
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  person_id INTEGER NOT NULL REFERENCES people (id),
  passkey_id INTEGER NOT NULL REFERENCES passkeys (id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
INSERT INTO browser_sessions_with_ids (hash, id, person_id, passkey_id, csrf_token, created_at,
    idle_expires_at, absolute_expires_at)
  SELECT hash, lower(hex(randomblob(16))), person_id, passkey_id, csrf_token, created_at,
    idle_expires_at, absolute_expires_at
  FROM browser_sessions;
DROP TABLE browser_sessions;
ALTER TABLE browser_sessions_with_ids RENAME TO browser_sessions;
CREATE TRIGGER browser_sessions_id_fixed BEFORE UPDATE OF id ON browser_sessions
WHEN new.id IS NOT old.id
BEGIN
  SELECT RAISE(ABORT, 'a browser session''s id never changes');
END;
```

Notes on the constraints:

- **The insert trigger** holds the sequence without a gap and the stored JSON to its row: the
  recorder reads the next sequence from `sqlite_sequence` inside its `BEGIN IMMEDIATE` transaction,
  where no other writer can take it, builds the event with it, and inserts that `seq` explicitly.
  `AUTOINCREMENT` then moves `sqlite_sequence` on, so a sequence is never reused while the database
  lives; a restore brings back the older `sqlite_sequence` with the rest, which is the rollback the
  FRD describes (R7).
- **The update trigger** needs no clock: a count rises only while the event's own `end_time` is
  within its minute, and never once a sink has received it. `count` and `end_time` must stay
  integers, so an update can neither remove nor retype them. The two `json_remove` results are
  SQLite's minified text of each side, so they compare equal exactly when everything else is equal.
  The store's own lookup adds the clock: it updates only an event whose `open_until` is after
  `store.clock()`.
- **The delete trigger** checks every row a statement deletes, so retention deletes one row at a
  time, the oldest, in a loop ([Retention](#retention)). The loop stops at the first row too new to
  remove, even where the clock stepped back and an older sequence carries a later `time` than one
  after it: removal follows the sequence, never the time. With no sink configured, no row in
  `audit_sinks` holds anything back (FRD R8).
- `recursive_triggers` is on (`S/database/database.ts:48-58`), so a `REPLACE` that deletes a row
  fires the delete trigger, as for the other append-only tables.
- **The index** `audit_events_open` is partial, so it holds only failures, and both its readers name
  it ([the lookup](#coalescing), [delivery](#reading-for-delivery)): with no `ANALYZE`, which the
  server never runs, SQLite answers `min(seq)` by walking the primary key from its start instead,
  the whole backlog. Delivery and retention otherwise read by `seq`, the primary key. The viewer's
  filters by credential and by action are P2's own migration.
- **`audit_sinks`** holds only the cursor in P1. A sink's state (when it last delivered, since when
  it has been failing, and its last error) lives in the dispatcher's memory, which P1's stderr lines
  read; P2's migration adds those columns, for Settings and `listAuditEvents`. P3's migration
  rebuilds this small table to add `otlp` to its names and its error classes, as a `CHECK` names
  only what the code can write.
- **`instance.uid`** follows its `name` column's pattern, the one-way trigger included
  (`S/database/migrations.ts:87-101`). `ADD COLUMN` cannot add `NOT NULL` without a default, and a
  `CHECK` on it is tested against the existing row, so the column allows null only until the
  `UPDATE` beside it sets it, in the same transaction; the trigger then refuses any change, null
  included, and the instance row is never deleted (`:98-101`). The builder checks it on read, as
  persisted state.
- **`browser_sessions`** is rebuilt, as the tags migration rebuilt its tables
  (`S/database/migrations.ts:627-645`), since `ALTER TABLE ADD COLUMN` can add neither `UNIQUE` nor
  a `NOT NULL` column without a default. Nothing references the table, so the rebuild breaks no
  foreign key, and migration 1's comment above it (`S/database/migrations.ts:103-104`) stays true.
  The session's `id` is 16 random bytes in hexadecimal, as `lower(hex(randomblob(16)))` makes them
  for existing sessions and `randomBytes(16).toString("hex")` does in `openBrowserSession`
  (`S/auth/browser-sessions.ts:40-62`).

The migration above was run against the ten migrations at ef3439fc in Node's `node:sqlite` (SQLite
3.54.1), with each trigger's every refusal exercised; the test the plan lists does the same.

### Retention

`--audit-retention-days N` (365 by default, 0 for forever). At start and with each upload sweep
(`S/store/file-sweep.ts:57-85`), in transactions of at most 1,000 deletions each:

```sql
DELETE FROM audit_events
WHERE seq = (SELECT min(seq) FROM audit_events)
  AND time < :cutoff
  AND NOT EXISTS (SELECT 1 FROM audit_sinks WHERE delivered_seq < audit_events.seq)
```

run until it deletes nothing, yielding between transactions as the sweep's vacuum steps do
(`S/store/file-sweep.ts:40-48`). The pages it frees return to the disk with the sweep's vacuum.

### Reading for delivery

A sink's batch, at most 100 events or 1 MiB, in exactly this form:

```sql
SELECT seq, uid, time, event FROM audit_events
WHERE seq > :delivered
  AND seq < coalesce(
    (SELECT min(seq) FROM audit_events INDEXED BY audit_events_open WHERE open_until > :now),
    9223372036854775807)
ORDER BY seq LIMIT 100
```

The subquery has no `seq > :delivered`: an open event is never behind a cursor, since no sink is
delivered past one. On 300,000 events with the last few failures open, with no `ANALYZE`, this form
searches the index (`SEARCH audit_events USING COVERING INDEX audit_events_open (open_until>?)`) and
answers in about 0.03 ms; without `INDEXED BY`, the same subquery walks the primary key
(`SEARCH audit_events`) and takes about 6 ms, growing with the backlog. `INDEXED BY` also fails the
statement if the index is ever missing, rather than slowing it. A sink new to the database is
inserted with `delivered_seq` one before the oldest retained event, or, with none retained, the
latest sequence ever taken (`sqlite_sequence`, 0 on a new log).

## How the store records

### What an identity carries

```ts
// The request an identity's call arrived as: the peer's address when it is
// known and usable, the user agent cut to 256 code units, the method, the
// routed path and the route's pattern, and the mount, which events name as
// the API's service.
export interface RequestOrigin {
  ip: string | undefined;
  userAgent: string | undefined;
  method: "GET" | "HEAD" | "POST";
  path: string;
  route: string;
  service: "web" | "operator/v1" | "agent";
}

export type Credential =
  | { kind: "registration"; registrationId: number }
  | { kind: "browser_session"; hash: Uint8Array; id: string; passkeyId: number }
  | { kind: "api_key"; id: number };

export interface Identity {
  actor: number;
  credential: Credential;
  grants: Grants;
  origin: RequestOrigin;
}
```

`Credential` changes at `S/identity.ts:14-17` and `Identity` at `:28-32`. The hash stays for the
store's lookups and never reaches the builder, whose inputs take the credential's `id` and
`passkeyId` only. `requestOrigin(c, service)` in `S/http/origin.ts` builds the origin in the route's
handler, where `c.req.routePath` is the route's own pattern, and each authentication takes it and
puts it in the identity it builds: `identityForBrowserSession` and `identityForRegistration`
(`S/identity.ts:38-77`), `resumeBrowserSession` (`S/auth/browser-sessions.ts:97-130`),
`authenticateApiKey` (`S/auth/api-keys.ts:194-226`), and `authenticateAgent`
(`S/auth/agent-tokens.ts:101-126`). The agent mount authenticates in middleware
(`S/http/agent-api.ts:87-98`), whose `routePath` is the mount's wildcard, but records no failure, so
only successes, which use the routed path, reach events from it. The writes with no identity yet
(sign-in, link use, and registration submit) take the origin as an argument of their own.

### The recording functions

```ts
// Who an event is by: an identity, the command line, or no one.
export type AuditActor =
  | { kind: "identity"; identity: Identity }
  | { kind: "cli"; command: "passkey-link" | "audit forget-sink" }
  | { kind: "none"; origin: RequestOrigin };

// recordAudit builds an action's event and inserts it, inside the caller's
// transaction, after the change it records. A failed insert throws, failing
// the transaction and its change with it.
export function recordAudit<A extends AuditAction>(
  store: Store,
  now: number,
  actor: AuditActor,
  action: A,
  input: AuditInput<A>,
): void;

// recordFailure records a failure in a transaction of its own, coalesced
// with an open event of its kind.
export function recordFailure(store: Store, actor: AuditActor, failure: AuditFailure): void;
```

- `AuditAction` is the union of the action names above; `AuditInput<A>` is each action's typed input
  (its targets as ids and names, its details as numbers, booleans, ids, and the operator's names),
  built from rows the store already holds. No request body, no message or answer text, no title, no
  file name, and no secret has a field to go in, which the marker test then checks.
- The action table in `S/audit/actions.ts` maps each action to its class and activity once; the
  builder reads it, and so does the coverage test.
- `recordAudit` reads the actor's names (`people.name`, `api_keys.name`, `passkeys.name`, the
  registration's agent and session), the instance's `uid` and `name`, and the next sequence, builds,
  and inserts.
- **Waking the dispatcher.** `recordAudit` calls `queueMicrotask(store.auditWake.wake)`. Store
  transactions are synchronous (`S/database/database.ts:75-93`), so the microtask runs once the
  transaction has committed, or rolled back, in which case the dispatcher finds nothing new and
  waits again: a spurious wake is harmless. `Database.transaction` is unchanged. `Store` gains
  `auditWake` (`S/store/store.ts:15-36`), a holder of one listener, a no-op until `agention serve`'s
  dispatcher sets it; the command line's commands record into a store whose wake reaches no one, and
  the dispatcher's 30-second poll finds what they wrote.
- **The command line's actor** reads `os.userInfo()`, `process.pid`, and `os.hostname()` in the
  builder, so the CLI passes only its command.

### Every write is covered

Declarations stay as they are (`S/http/operations.ts:60-71`). The coverage test, in the in-process
harness (`S/http/test-harness.ts`), walks every `POST` declaration (`operatorOperations`,
`agentOperations`, the thread operations both share, and `registration`) and every `POST` route of
the web mount, as the app lists its routes, and fails on any it has no driver for, so a new write
cannot be added without one. It holds the one list of declarations that record nothing, the read
marks `markRead`, `markUnread`, `bulkRead`, and `markSessionLogRead`; checks that every other
declaration's name is an action in the action table; and drives each, finding exactly the events the
map below lists, for every input that changes what is recorded (`actOnThreads`'s actions, for one),
or none.

### The map at ef3439fc

Every `POST` operation, the store function it calls, and what that records. `op` is
`S/http/operator-operations.ts`, `th` is `S/http/thread-operations.ts`, and `ag` is
`S/http/agent-operations.ts`. A refusal of a known key that reaches any operation records as
[above](#failures-after-authentication).

| Declaration                      | Store function                                                                                                                                      | Records                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `sendMessage`, `th:52`           | `sendMessage`, `S/store/threads.ts:582`                                                                                                             | `sendMessage`                                                                               |
| `markRead`, `th:63`              | `markRead`, `S/store/marks.ts:59`                                                                                                                   | none                                                                                        |
| `markUnread`, `th:74`            | `markUnread`, `S/store/marks.ts:88`                                                                                                                 | none                                                                                        |
| `archiveThread`, `th:85`         | `archiveThread`, `S/store/marks.ts:181`                                                                                                             | `archiveThread`                                                                             |
| `uploadFile`, `th:96`            | `receiveUpload`, `S/http/uploads.ts:71`: `beginUpload` `S/store/files.ts:45`, `writeChunk` `:108`, `completeUpload` `:119`, or `abortUpload` `:202` | `uploadFile`, in `completeUpload`'s transaction; none for begin, chunks, or abort           |
| `removeUpload`, `th:111`         | `removeUpload`, `S/store/files.ts:157`                                                                                                              | `removeUpload`                                                                              |
| `updateSession`, `ag:24`         | `updateSession`, `S/store/sessions.ts:151`                                                                                                          | `updateSession`, when an entry is logged                                                    |
| `createThread`, `ag:35`          | `createThread`, `S/store/threads.ts:543` (`addThread` `:488`)                                                                                       | `createThread`                                                                              |
| `register`, `ag:78`              | `submitRegistration`, `S/store/registrations.ts:128`                                                                                                | `register`, for a new registration                                                          |
| `startThread`, `op:171`          | `startThread`, `S/store/threads.ts:566` (`addThread` `:488`)                                                                                        | `startThread`                                                                               |
| `bulkRead`, `op:182`             | `bulkRead`, `S/store/marks.ts:206`                                                                                                                  | none                                                                                        |
| `bulkArchive`, `op:192`          | `bulkArchive`, `S/store/marks.ts:225`                                                                                                               | `bulkArchive`                                                                               |
| `actOnThreads`, `op:202`         | `actOnThreads`, `S/store/thread-actions.ts:149` (`declineAsks` `S/store/threads.ts:676`)                                                            | `actOnThreads` for an archiving action; none for read and unread                            |
| `actOnMatchingThreads`, `op:214` | `actOnMatchingThreads`, `S/store/thread-actions.ts:172`                                                                                             | as `actOnThreads`                                                                           |
| `markSessionLogRead`, `op:249`   | `readSessionLog`, `S/store/sessions.ts:273`                                                                                                         | none                                                                                        |
| `createGroup`, `op:269`          | `createGroup`, `S/store/groups-and-tags.ts:111`                                                                                                     | `createGroup`                                                                               |
| `orderGroups`, `op:279`          | `orderGroups`, `S/store/groups-and-tags.ts:175`                                                                                                     | `orderGroups`                                                                               |
| `renameGroup`, `op:292`          | `renameGroup`, `S/store/groups-and-tags.ts:136`                                                                                                     | `renameGroup`                                                                               |
| `recolorGroup`, `op:303`         | `recolorGroup`, `S/store/groups-and-tags.ts:158`                                                                                                    | `recolorGroup`                                                                              |
| `removeGroup`, `op:314`          | `removeGroup`, `S/store/groups-and-tags.ts:199`                                                                                                     | `removeGroup`                                                                               |
| `createTag`, `op:327`            | `createTag`, `S/store/groups-and-tags.ts:234`                                                                                                       | `createTag`                                                                                 |
| `renameTag`, `op:337`            | `renameTag`, `S/store/groups-and-tags.ts:246`                                                                                                       | `renameTag`                                                                                 |
| `recolorTag`, `op:351`           | `recolorTag`, `S/store/groups-and-tags.ts:267`                                                                                                      | `recolorTag`                                                                                |
| `removeTag`, `op:362`            | `removeTag`, `S/store/groups-and-tags.ts:280`                                                                                                       | `removeTag`                                                                                 |
| `setSessionGroup`, `op:375`      | `setSessionGroup`, `S/store/groups-and-tags.ts:321`                                                                                                 | `setSessionGroup`                                                                           |
| `setSessionTags`, `op:389`       | `setSessionTags`, `S/store/groups-and-tags.ts:364`                                                                                                  | `setSessionTags`                                                                            |
| `setAgentTags`, `op:403`         | `setAgentTags`, `S/store/groups-and-tags.ts:377`                                                                                                    | `setAgentTags`                                                                              |
| `approveRegistration`, `op:429`  | `approveRegistration`, `S/store/registrations.ts:250` (`decide` `:216`)                                                                             | `approveRegistration`; an `authorizeScope` failure for a group or tags refused (`:281-282`) |
| `rejectRegistration`, `op:444`   | `rejectRegistration`, `S/store/registrations.ts:301`                                                                                                | `rejectRegistration`                                                                        |
| `revokeRegistration`, `op:454`   | `revokeRegistration`, `S/store/registrations.ts:318`                                                                                                | `revokeRegistration`                                                                        |

The web-only routes (`S/http/web-api.ts`):

| Route                                        | Store function                                                    | Records                                                      |
| -------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `POST /auth/signin/begin`, `:157`            | `beginSignIn`, `S/auth/passkeys.ts:121`                           | none: it stores nothing                                      |
| `POST /auth/signin/finish`, `:158-166`       | `finishSignIn`, `S/auth/passkeys.ts:137` (transaction `:183-214`) | `signIn`, naming the session it replaced; a failure `signIn` |
| `POST /auth/link/begin`, `:167-173`          | `beginLink`, `S/auth/passkeys.ts:376`                             | a failure `usePasskeyLink`; none on success                  |
| `POST /auth/link/finish`, `:174-181`         | `finishLink`, `S/auth/passkeys.ts:408` (transaction `:426-457`)   | `usePasskeyLink` and its effects; a failure `usePasskeyLink` |
| `POST /auth/signout`, `:182-187`             | `signOut`, `S/auth/browser-sessions.ts:81`                        | `signOut`, when a session ended                              |
| `POST /passkeys/register/begin`, `:192-195`  | `beginAdding`, `S/auth/passkeys.ts:467`                           | none: it stores nothing                                      |
| `POST /passkeys/register/finish`, `:196-201` | `finishAdding`, `S/auth/passkeys.ts:497`                          | `addPasskey`                                                 |
| `POST /passkeys/:id/name`, `:202-207`        | `renamePasskey`, `S/auth/operator-passkeys.ts:43`                 | `renamePasskey`                                              |
| `POST /passkeys/:id/remove`, `:208-214`      | `removePasskey`, `S/auth/operator-passkeys.ts:59`                 | `removePasskey`, naming the sessions it ended                |
| `POST /settings/voice`, `:219-222`           | `saveVoiceSettings`, `S/store/voice-settings.ts:140`              | `setVoiceSettings`                                           |
| `POST /settings/voice/clear`, `:223-225`     | `clearVoiceSettings`, `S/store/voice-settings.ts:191`             | `clearVoiceSettings`                                         |
| `POST /transcriptions`, `:229-231`           | `transcribe`, `S/http/transcription-route.ts`                     | none: it writes nothing                                      |
| `POST /keys`, `:236-238`                     | `createApiKey`, `S/auth/api-keys.ts:120`                          | `createApiKey`                                               |
| `POST /keys/:id/revoke`, `:239-241`          | `revokeApiKey`, `S/auth/api-keys.ts:164`                          | `revokeApiKey`                                               |

Every other function that writes or refuses, and what it records:

| Function                                                                          | Writes or refuses                                       | Records                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `authenticateApiKey`, `S/auth/api-keys.ts:194` (`:215-217`)                       | `last_used_at`                                          | `activateApiKey` when it was null, in one transaction with the update; a failure `authenticateApiKey` through the budget |
| `checkCredential`, `S/identity.ts:88` (`:99-108`)                                 | refuses a key revoked or expired since it authenticated | a failure `authenticateApiKey`, after the operation's transaction rolls back                                             |
| `deleteDead`, `S/auth/api-keys.ts:74`                                             | dead keys, in create and revoke                         | none: housekeeping                                                                                                       |
| `openBrowserSession`, `S/auth/browser-sessions.ts:40`                             | a session, its new `id`                                 | its caller's `signIn` or `usePasskeyLink`                                                                                |
| `closeBrowserSession`, `S/auth/browser-sessions.ts:67`                            | a session                                               | its caller's `signOut`, or the ended session in its caller's `signIn`                                                    |
| `resumeBrowserSession`, `S/auth/browser-sessions.ts:97` (`:119-128`)              | the idle expiry                                         | none                                                                                                                     |
| `deleteExpired`, `S/auth/browser-sessions.ts:24`, `S/auth/passkey-links.ts:15`    | expired rows                                            | none: housekeeping                                                                                                       |
| `issuePasskeyLink`, `S/auth/passkey-links.ts:21`                                  | a link, replacing unused ones                           | `issuePasskeyLink`, from the command line (`S/cli.ts:415`)                                                               |
| `consumePasskeyLink`, `S/auth/passkey-links.ts:56`                                | the link                                                | its caller's `usePasskeyLink`                                                                                            |
| `markChallengeUsed`, `S/auth/sealed-challenges.ts:77`                             | a used challenge                                        | its caller's ceremony                                                                                                    |
| `insertPasskey`, `S/auth/passkeys.ts:344`                                         | a passkey                                               | its caller's `addPasskey`                                                                                                |
| `insertOperator`, `S/store/directory.ts:29`                                       | the operator                                            | the link's `createOperator`                                                                                              |
| `insertAgent`, `insertSession`, `S/store/directory.ts:45`, `:60`                  | an agent, a session                                     | `approveRegistration`'s `data.new_agent` and `data.new_session`                                                          |
| `putInGroup`, `tagSession`, `S/store/groups-and-tags.ts:301`, `:359`              | membership, tags                                        | their caller's (`setSessionGroup`, `setSessionTags`, `approveRegistration`)                                              |
| `statusOnWrite`, `S/store/sessions.ts:194`                                        | an inferred or reported status                          | its write's event                                                                                                        |
| `declineAsks`, `S/store/threads.ts:676`                                           | decline messages                                        | its caller's `actOnThreads` or `actOnMatchingThreads`                                                                    |
| `markSeen`, `S/store/presence.ts:18`                                              | `last_seen_at`                                          | none                                                                                                                     |
| `removePending`, `S/store/files.ts:188`; `sweepFiles`, `S/store/file-sweep.ts:25` | a pending file                                          | none: abort and sweep                                                                                                    |
| `storeName`, `S/store/server-name.ts:25`                                          | the server's name                                       | none: the server's own life                                                                                              |
| `forgetSink` (new), `S/cli.ts`                                                    | a sink's cursor                                         | `forgetSink`                                                                                                             |

## The options

`agention serve`, beside its options at `S/cli.ts:278-288`, with the usage text at `S/cli.ts:38-65`
and the operator guide's options table (`docs/operator-guide.md:110-120`) listing them:

| Option                     | Default | Meaning, and when it is refused                                                                                                                                |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--audit-stdout`           | off     | Write each event to standard output as a JSON line; `agention serve` writes nothing else there                                                                 |
| `--audit-dir DIR`          | none    | Write events to `DIR/audit.jsonl`, rotated daily at UTC midnight to `audit-YYYY-MM-DD.jsonl`; `DIR` is made 0700, or refused if any other user has access      |
| `--audit-group NAME`       | none    | Make `DIR` 0750 and its files 0640 in group `NAME`, for a collector running as its own user; needs `--audit-dir`, a group that exists, and a server user in it |
| `--audit-keep-days N`      | 30      | Keep the newest `N` rotated files, 1 to 3,650; needs `--audit-dir`                                                                                             |
| `--audit-retention-days N` | 365     | Remove events older than `N` days once every sink has them, 1 to 36,500, or 0 to keep them forever                                                             |

- Numbers are whole numbers in range, read as `--quiet-minutes` is (`S/cli.ts:235-246`); anything
  else is a usage error.
- **The group lookup.** `--audit-group NAME` names the group, as FRD R16 has the operator do, so the
  server resolves it to a gid, once at start. Node has no group database lookup: `os.userInfo()`
  gives the user's uid and primary gid but no group names, and `process.getgroups()` gives gids
  only. Reading `/etc/group` itself would miss groups from other name services (LDAP, sssd), which
  `getent` consults through the system's own configuration. So the server runs `getent group NAME`
  with `execFileSync`, without a shell, reads the gid from its answer, and refuses a group that does
  not resolve or that `process.getgroups()` does not include. A system without `getent`, such as
  macOS, refuses the option, saying so; the macOS setup is untested (`docs/operator-guide.md`,
  "macOS: a launchd agent").
- `--audit-dir` is checked by `packages/private-files`, which learns a group-readable variant of its
  rule: the directory belongs to the server's user and, with `--audit-group`, to that group, mode
  0750 with no access for others, and every directory above it belongs to the user or root with no
  one else able to write to it (`checkAncestor`, `packages/private-files/src/private-files.ts:140`),
  as for the data directory. A directory the server makes it makes with that mode and group; one
  that exists with any other is refused, never repaired.
- Sinks change only on restart. No option takes a secret.

`agention audit forget-sink --data DIR KIND`, with `KIND` `stdout` or `file` (and `otlp` from P3),
opens the database as `agention passkey-link` does (`S/cli.ts:385-428`), removes the sink's cursor,
and records `forgetSink` with the sequence it had delivered, in one transaction. A kind with no
cursor is a usage error that changes nothing. `agention audit` lists `forget-sink` as its one
command, and the top-level usage (`S/cli.ts:24-36`) gains `audit`.

## Collectors and the file sink's group

**Packaged Vector and Grafana Alloy run as their own users**, `vector` and `alloy`, each in a group
of its own, which is what `--audit-group` is for. Both Debian packages also add their user to `adm`;
Vector's RPM adds it to `systemd-journal` only. Their containers run as root by default. The
evidence, from each project's packaging at its latest release tag and Vector's own docs, is in
[prior art](prior-art-research.md), section 6.

The operator guide's recipe for a packaged collector is a group of the operator's own, with the
server's user and the collector's in it, and a directory the collector can reach:

```bash
sudo groupadd agention-audit
sudo usermod -aG agention-audit "$USER"     # the server's user
sudo usermod -aG agention-audit vector      # or alloy
sudo install -d -o "$USER" -g agention-audit -m 0750 /var/lib/agention-audit
sudo systemctl restart vector               # or alloy, to take the new group
agention serve ... --audit-dir /var/lib/agention-audit --audit-group agention-audit
```

- **The directory.** `/var/lib/agention-audit` sits under directories that belong to root and that
  no group or other user can write (`/`, `/var`, and `/var/lib` are root's, 0755, on Debian 12,
  checked on its test host), which the private-file rule requires of every ancestor.
  `/var/log/agention` would not do on Ubuntu, whose `/var/log` is root's in group `syslog` with mode
  0775, a group-writable ancestor the rule refuses. Ubuntu's `/var/lib` was not checked here; the
  live test does so, and the guide names another directory if it differs.
- **Not `adm`.** Both Debian packages add their collector to `adm`, so `--audit-group adm` would
  work on Debian with no change to the collector, but it would put the server's user in `adm`, which
  reads the system's logs; the guide recommends a group for the audit files alone.
- **The server's user must be in the group when it starts.** A systemd user unit
  (`docs/operator-guide.md`, "Linux: a systemd user unit") runs under the user's manager, which
  takes new groups only when it starts again. With lingering on, as the guide sets it, that manager
  outlives logins, so the user restarts it, `sudo systemctl restart user@$(id -u).service`, or
  reboots.
- **The directory's parents must let the collector through**: the default data directory under the
  operator's home is not one a collector can reach, which is why the audit files live elsewhere.

## Testing notes

What P1's tests need from this design, beyond the plan's list:

- **Fixtures.** The three class schemas from schema.ocsf.io's export without profiles, for the
  pinned version, under `apps/server/src/audit/fixtures/`, with a note of their URL, the tag they
  match, and the date fetched; and the tag's `ocsf:` source files this design cites, for a reviewer
  to check them against. `ajv` validates every action's event against its class's schema, and the
  same test checks `type_uid`, `ip` (`net.isIP`, at most 40 characters), and `metadata.uid` (a
  UUID).
- **Samples.** Each action's event in the tests is built from the store's own rows by driving the
  action, never written by hand, so the fixture checks what the code emits. One sample per shape was
  validated while writing this design, against both 1.9.0 and 1.10.0: each class and activity, every
  credential kind, a coalesced failure, an in-process request, the command line, and the sessions a
  sign-in, a link, and a passkey's removal end. Beyond the schema, the tests assert what the schema
  cannot: a scope refusal's `metadata.event_code` is `authorizeScope` while its `api.operation` is
  the operation refused, and every 3002's `service.name` is the server's name.
- **Negative shapes** the schema refuses, which the builder must never emit: an empty
  `src_endpoint`, an empty `actor`, an empty `reporter`, a 3002 without `service`, a `user` with
  only `type_id`, and any key the class does not define.
- **Refusals.** Each kind of failure is recorded once, at the place above: the mount's scope
  refusal, `approveRegistration`'s group or tags refused to a key without `sessions:write`, a key
  revoked during a long poll, and a revoked or expired key presented; and the two budgets' refusals
  of a key at authentication are never recorded twice.

## Rulings

The lead ruled on 2026-11-26, after the reviews, and the HLA matches this design: 3002 carries
`service`; `src_endpoint` always names something; no correlation field, since the FRD asks for none
and a link's effects share its session, time, and path; no Logoff for a session another action ends,
which the causing event names; `actOnThreads`, `actOnMatchingThreads`, and `createOperator` are
recorded; `metadata.event_code` carries the action; the command line's user is `type_id` 99;
`entity` with `data.previous_name`, not `entity_result`; the instance id in `metadata.reporter`;
OCSF 1.9.0; the viewer's indexes and the sinks' state columns in P2's migration; no failure codes
for sign-ins and links, and coalescing by action, credential, and code; no `audit` field on
declarations, the coverage test holding the list; scope refusals coalesced per key and minute,
keeping the first operation; `forgetSink` keeping its event; `http_response.code` only where it is
the caller's answer. FRD R2's estimate stands as the operator wrote it, with the bound stated under
[Coalescing](#coalescing); the lead raises it with the operator if it matters.
