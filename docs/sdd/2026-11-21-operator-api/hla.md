# Operator API: High-Level Architecture

- Requirements: [FRD](frd.md); plan: [plan](plan.md)
- Baseline: the server as of v0.4.0, described in `docs/architecture.md`

## Shape

Each documented mount's routes are declared once, as operations, and both the routes and the
documentation are built from those declarations:

```mermaid
flowchart LR
  ui[Web UI] -- cookie + CSRF --> web["/api/web"]
  client[Client such as pitwall] -- "Bearer key" --> op["/api/operator/v1"]
  agent[Agent bridge] -- signed token --> ag["/api/agent"]
  web --> operatorOps[(operator operations)]
  web --> webRoutes[web-only routes]
  op --> operatorOps
  ag --> agentOps[(agent operations)]
  operatorOps --> store[Store]
  agentOps --> store
  webRoutes --> store
  operatorOps --> docs["/docs/api/ (with --api-docs)"]
  agentOps --> docs
```

This follows ruling 1: a third, key-only mount serving the web UI's operations with the same code.
The web UI keeps its own mount, whose cookie credential and unversioned contract fit a UI the server
ships in step, and adds the routes no key may call. No operation has a second handler, so A1 holds
by construction.

### Why not the alternatives

- **The web mount takes keys too.** It would carry two credentials with different rules (CSRF and
  `Origin` for one, none for the other) on one mount, and its refusal of `Authorization`, which
  keeps a token from ever riding a cookie's authority, would go. Separate mounts keep each
  credential's checks whole, as the agent and web mounts already do.
- **A separately designed resource API.** Two implementations of the same operations, which A1 rules
  out, and a second shape for every reader to learn.
- **Documentation listed beside the routes, with a test comparing the two.** Hono routes carry no
  schemas, so the list would be a second definition, and the test could only catch drift in the
  route list, never in a field. Declaring the operation once is the simpler way to meet D2.

## Operations

An operation declares its name, method and path, a one-line summary, its path, query and body
schemas and its response schema from `packages/api`, and its handler, which takes the store, the
identity and the parsed input and returns the response schema's type, so the compiler holds each
declared response to the code. A mount builds Hono routes from its list: parsing every input through
its schema, as `parseBody` and `parseQuery` do now, then calling the handler.

- **Operator operations** (`apps/server/src/http/operator-operations.ts`): every operation a key may
  call, each with the one scope it requires. Being in this list is what puts an operation on the
  operator mount, and its scope is required, so leaving an operation out keeps it off and nothing
  fails open. The web mount builds the same list for the browser session, which holds every scope.
  The operations on one thread, which the agent mount shares (`threadOperations`, in
  `thread-operations.ts`), are entries of both lists, so they keep one handler each.
- **Agent operations** (`apps/server/src/http/agent-operations.ts`): the agent mount's routes,
  declared the same way so they are documented (ruling 2). Its middleware (the version header, the
  cookie refusal, token authentication, rate spending and marking a session seen) stays as it is,
  and so does every answer (E1). Registration, whose token is checked against the key it carries,
  declares its schemas the same way and keeps its own authentication step.
- **Web-only routes** stay plain Hono routes in `web-api.ts`: the passkey ceremonies and passkeys,
  sign-in and signing out, Settings and voice, transcription, and key management. They use cookies,
  ceremonies or a raw body, which an operation's shape does not need to carry.

One path can name different operations on different mounts: `POST /s/:agent/:session/threads` is an
agent's `createThread` on the agent mount and the operator's `startThread` on the others. Each list
holds its own entry, so this is two declarations, not a mount-dependent handler.

Routes that answer `{}` or an untyped store result get a response schema in `packages/api`, since a
documented response must have one.

## Scopes

A scope is `<resource>:<access>`: `threads:read`, `threads:write`, `sessions:read`, `sessions:write`
and `sessions:approve`. A write or approve scope includes its resource's read, and neither includes
the other (K4). `packages/api` defines them as one enum, so a later resource is a new member. Each
operator operation names the one scope it requires:

| Scope              | Operations                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `threads:read`     | thread list, counts, the wait across sessions, a thread, a thread's files, a file                                  |
| `threads:write`    | start a thread, send a message, read, unread, archive, bulk read and archive, upload, remove an upload             |
| `sessions:read`    | sessions, a session's log, groups and tags, registrations                                                          |
| `sessions:write`   | the log's read mark, group create, rename, remove, tag rename, remove, a session's group and tags, an agent's tags |
| `sessions:approve` | registration approve, reject, revoke                                                                               |

A test over the list confirms every operation requiring a read scope is a `GET` without a body whose
handler writes nothing, so a read key cannot change anything; the only writes its requests cause are
credential bookkeeping in authentication, before the handler (a browser session's idle expiry, a
key's last use).

## Keys

- **Table.** Migration 5 adds `api_keys`: an id, the operator's person id, the name, the scopes, the
  SHA-256 of the secret, and the created, expiry (none for a key without one), last-used and revoked
  times. A revoked or expired key keeps its row so the list can show it, until the operator next
  creates or revokes a key, which deletes the dead rows; recording a key's use deletes nothing.
- **Secret.** 256 random bits, written as `agention_` and their base64url, so people and secret
  scanners recognize one. Only its hash is stored (K5), as with browser sessions and passkey links.
- **Identity.** `Credential` gains `{ kind: "api_key", id }`, and `Grants` gains the scopes an
  identity holds. A key's grants are every session and its scopes; a browser session holds every
  scope; an agent's registration holds `threads:write` over its own session only, which is what it
  can do today, so the thread routes check scopes the same way on every mount. The mount refuses an
  operation whose scope the identity lacks as `not_found`, as administration is refused today,
  before any input is read, and every store entry point confirms the scope again inside its
  transaction, so an adapter other than the HTTP mounts cannot skip it. `authorizeAdministration`
  gives way to the scope check, since `sessions:approve` now covers what administration meant.
  `checkCredential` confirms, inside each operation's transaction, that the key is unrevoked and
  unexpired, so revocation takes effect on the next request (K5). Last used is written at most
  hourly, as a browser session's idle expiry is.
- **Recovery.** Replacing the operator's passkeys with `agention passkey-link` also revokes every
  live key, in the same transaction, since whoever held the old passkeys may have created keys
  (ruling 8).
- **Management.** On the web mount only: `GET /keys`; `POST /keys` with the name, scopes and expiry,
  answering the secret once; and `POST /keys/:id/revoke`. Creating and revoking need the recent
  sign-in that passkey changes need; listing does not, as listing passkeys does not. At most 20 keys
  that are neither revoked nor expired, checked in the creating transaction.
- **Expiry.** 7, 30, 60 or 90 days, a date up to 365 days away, or none (K2).

## The operator mount

- `/api/operator/v1/` accepts only `Authorization: Bearer agention_...`, and refuses any request
  carrying a cookie, as the agent mount does, so a browser's ambient credential never reaches it. It
  needs no CSRF token or `Origin`, since a browser never attaches a bearer key on its own.
- **Version in the path.** `GET /api/operator` answers the versions the server serves,
  `{"versions":[1]}`, and an unknown version is the existing `not_found`. A version changes only
  additively (a new operation, a new optional request field, a new response field); a change that
  would break a client is a new version beside the old, by a maintainer's decision (A2). The agent
  mount's header exists because bridges and servers release apart and the bridge refuses an older
  server; a client of this mount needs only to know a version is served, which the path says.
- **Rates.** A key's requests spend a budget of the key's own, as a registered agent key's do, and
  failed key authentication spends a shared `failedKeyAuth` budget, spent only on failure.
- **Errors** are the shared error shape. A refused key is told to check it or create a new one in
  Settings, with nothing that says whether the key ever existed.

## Waiting for what is new (A3)

`GET /api/operator/v1/wait`, an operator operation under `threads:read`, is the agent long poll's
counterpart across every session: it answers at once when a thread has a message newer than the
client's `since` that the operator has not read, and otherwise when one commits, when the key is
revoked or expires, when the client disconnects, when the server shuts down, or when its wait (up to
the agent wait's bound) runs out. Held on the web mount by a browser session, it ends likewise when
that session ends or expires. Its answer is a page of thread summaries, each naming its session, and
the next `since`, an opaque cursor, so a client is never woken twice for one message.

- **Cursor.** Positions count within a session (`sessions.last_pos`), and a message has no stable
  integer key of its own: it is keyed by its thread and sequence, and its table's rowid is no
  column's alias, so `VACUUM` may renumber it. Migration 6 therefore adds `message_positions`, whose
  `INTEGER PRIMARY KEY AUTOINCREMENT` gives every message a position in the order messages are
  written that is kept and never reused, so it never goes backwards. A trigger fills it as each
  message is written, triggers refuse updating or deleting a position, and the migration numbers the
  messages already written in the order they were stored. The cross-session cursor is a position
  there, in a cursor of its own kind, so no session's `since` is taken for one. A `since` past the
  latest counts as none, as the agent wait's does.
- **Wake-up.** `SessionNotifier` gains one more channel, woken on every session's notification, so
  the operator's waiters wake on any commit and on any revocation, including their own key's. The
  key revocation path notifies that channel too, so a revoked key's wait ends at once (K5), and so
  does every way a browser session ends but expiry: signing out, signing in again on that browser,
  removing the passkey that signed it in, and replacing the passkeys through a link. Expiry needs no
  notification: the wait polls again when its credential expires, so an expired key's wait ends at
  once too.
- **Reuse.** The loop is `waitForThreads`'s: poll in a transaction with authorization, wait on the
  notifier, poll again. The shared part moves into one function both waits call, so the agent wait
  keeps its behavior (E1).
- On the web mount it is available too, as every operator operation is; the web UI keeps polling,
  and moving it to the wait is not part of this effort.

## Documentation

- `apps/server/src/http/openapi.ts` builds one OpenAPI 3.1 document from the operator and agent
  operations: `z.toJSONSchema` for every schema, the bearer scheme for the operator mount and the
  signed token for the agent mount, the agent version header, and the error shape with its codes and
  statuses. Rules a schema enforces only in code (zod refinements) are absent from the generated
  schema, so the document may describe less than the server checks, never more; a request breaking
  such a rule answers `invalid_input`, naming the field when the rule concerns one.
- **Shared schemas.** The schemas that recur across operations, such as `Message` and
  `ThreadSummary`, are described once each under `components.schemas` and referenced by `$ref`
  wherever they appear, so the document reads, and changes, in one place for each. Each component is
  the body zod gives the named schema under a description's `$defs`, referenced by its plain id. A
  named schema that reads differently as input than as output (one with defaults, or that reads text
  into values, or that holds such a schema) is described in one direction only, as `Ask` is only
  sent and `AskRead` only answered, and one whose id would need two bodies throws. The descriptions
  come from `@wayfarerlabs/agention-api/json-schemas`, an entry point of its own so the web bundle
  never carries them; it also refuses a cycle that no named schema breaks.
- `agention serve --api-docs` serves `GET /docs/api/openapi.json` and `GET /docs/api/`, a page the
  server renders from the same document: each operation's method, path, summary, scope and
  parameters, and its schemas as formatted JSON, then a section for each shared schema, which every
  `$ref` on the page links to. `/docs/api` leads to the page with a permanent redirect. It is static
  HTML with no script or style, served under a policy of its own that allows nothing to load
  (`default-src 'none'`), and adds no dependency. Documentation is served without sign-in, since it
  describes the contract and no data. Without the flag, every path under `/docs/api` answers the
  JSON `not_found`, not the web UI's index page, so nothing is served there (D1).
- The document is committed at `docs/api/openapi.json`, and a test fails when the generated document
  differs from it byte for byte (ruling 2). It is a generated output, listed with the others in
  `docs/development-context.md`, and regenerated by a script beside the plugin generator's.

## Web UI

### Settings sections (S1)

Settings becomes a list of sections, declared once in `apps/web/src/views/settings/sections.ts`:
each with a slug, a title, the group it is listed under, and its component. The router reads
`/settings/<slug>`; the navigation and the page are built from the list, so a later section is one
entry and one component. Groups, in order: **Access** (Passkeys, API keys) and **Features** (Voice),
with **Sign out** last, apart from the groups.

- **Wide screens:** a navigation column, the groups with their sections, beside the open section,
  with the current one marked (`aria-current`). `/settings` opens the first section.
- **Narrow screens:** `/settings` shows the navigation alone, as a full-width list; a section's page
  shows a back link to it in place of the column. The breakpoint is the one the app's layout already
  uses, in CSS, so nothing about the layout is decided in script.
- Passkeys is at `/settings/passkeys`, and `/passkeys` redirects there, replacing the history entry
  (S1, ruling 5).
- The recent sign-in offer, which every section that changes a secret needs, moves from the view's
  top into the sections that need it (Passkeys, Voice, API keys), shown once per section. Each
  section loads only its own data. Since the layout is decided in CSS alone, `/settings` mounts the
  first section, which loads its data, on every width, hiding it on a narrow screen.

This is the pattern later settings follow; agention#38's reorganization of voice settings fits
inside its Voice section.

### API keys section

The API keys section, under Access: the list (K3); a create form with name, scopes and expiry,
warning when no expiry is chosen; a one-time view of the new secret with a copy control and a note
that it is shown once; and revoke, with confirmation. A stale sign-in leads to the same re-sign-in
prompt the passkey section uses.

## Security

- A key is a bearer credential with the operator's reach within its scopes, so it is never logged,
  never sent back after creation, kept only as a hash, and bounded in life unless the operator
  chooses otherwise, which Settings warns against.
- The operator mount has no cookie path and the web mount no `Authorization` path, so neither
  credential can borrow the other's authority, and CSRF does not arise on the key mount.
- No key can manage keys, passkeys or Settings, so a leaked key cannot make itself another key, add
  a passkey, or change where audio goes. Only a `sessions:approve` key can approve an agent's
  registration (ruling 5), so the operator guide and the key form say what that scope grants.
- ADR 0003 records that integrations may act for the operator through keys, superseding that clause
  of ADR 0001 "Not doing"; `SECURITY.md` gains the key's threat model; and
  `docs/review-checklist.md` gains a check that every new operation names its scope, and that read
  scopes stay read-only.

## Out of scope here

As the FRD says: push to clients, keys limited to some sessions, OAuth, and anyone but the operator.
