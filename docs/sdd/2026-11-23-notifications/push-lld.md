# Notifications: Push Low-Level Design

<!-- cspell:ignore VAPID vapid aes128gcm p256dh ECDH HKDF renotify unixepoch notificationclick -->

- Status: Following the HLA and the FRD as accepted, a rule being a saved view that notifies (FRD
  rulings 7, 9, and 10).
- Date: 2026-11-23
- Requirements: [FRD](frd.md); architecture: [HLA](hla.md); research:
  [prior art](prior-art-research.md); plan item: "`push-lld.md`" under Design in [the plan](plan.md)
- Base: `main` at ef3439f, and saved views (agention#184) at 11c48418, which PR 2 builds on. Every
  `file:line` below is at ef3439f unless it names agention#184, whose are at 11c48418.

This design fills in PR 2 of the plan: the schema and migration, the check, the mark, the push keys
and token, the encryption, the endpoint rule, the sender, the routes, and how the service worker
shows a notification and opens its thread. It designs nothing for the alternatives the HLA's last
section prices.

## Where the code goes

| Where                                          | Holds                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/api/src/notifications.ts` (new)      | the refused filters, the route inputs and answers, the push payload       |
| `apps/server/src/database/migrations.ts`       | the notifications migration, appended after the last on `main`            |
| `apps/server/src/store/notifications.ts` (new) | On and Off, subscriptions, and the check, each in its own transaction     |
| `apps/server/src/store/saved-views.ts`         | `readView`, exported; `replaceSavedView` ending a view's notifying        |
| `apps/server/src/store/thread-lists.ts`        | `totalOf` taking its scope; `threadKept`, exported                        |
| `apps/server/src/store/threads.ts`             | the hook after an agent's write; `raiseReadMark` clearing the mark        |
| `apps/server/src/store/marks.ts`               | `archiveFound` clearing the mark                                          |
| `apps/server/src/push/` (new)                  | `vapid.ts`, `encryption.ts`, `endpoint.ts`, `sender.ts`                   |
| `apps/server/src/http/web-api.ts`              | the notification routes, beside the API keys' at `:233-240`               |
| `apps/server/src/auth/browser-sessions.ts`     | `signOut` removing the session's subscription                             |
| `packages/build/src/bundle.ts`                 | `bundleScript` taking a fixed name                                        |
| `apps/web/src/push/` (new)                     | the device intent, subscribe and refresh, and the page's message listener |
| `apps/web/src/views/settings/SavedViews.tsx`   | each row's Notify switch; Remove's question                               |
| `apps/web/src/views/list/SavedViews.tsx`       | Replace's question                                                        |
| `apps/web/src/service-worker.ts` (new)         | `push` and `notificationclick`                                            |
| `apps/web/src/routes.ts` (new)                 | the route table, moved from `router.tsx`, its callers importing it here   |

The check lives in the store because it is a read of the store's own tables in a transaction; the
sender lives apart because it does network I/O, which no store function does.

## Data model: the migration

Migrations run forward only, in order, each in its own transaction with the bump of `user_version`,
and one that has shipped never changes (`apps/server/src/database/migrations.ts:5-8`). This one is
appended after the last migration on `main` when it lands, whatever number that makes it (ten are
frozen on `main` today, and other efforts may append theirs first), always after saved views' own
(agention#184, `apps/server/src/database/migrations.ts:681-693`), and its hash joins `frozen` in
`migrations.test.ts` in the same change, since every migration is frozen, released or not
(`migrations.test.ts:5-10`).

```sql
-- Whether a saved view notifies the operator: an agent's message notifies
-- when its thread then matches the list of any view that does, by its
-- filters alone. It follows the view: a rename keeps it, a replaced list is
-- what the next check matches, and removing the view removes it. No view
-- that notifies has search, overdue, or the agent's reading on, which the
-- store keeps so. Only the web UI's notification routes read or write it; no
-- saved views operation selects it.
ALTER TABLE saved_views ADD COLUMN notifies INTEGER NOT NULL DEFAULT 0
  CHECK (notifies IN (0, 1));

-- The starting view, Blocking asks, which notifies: added once, numbered
-- past a name a view already has, ignoring the case of ASCII letters as the
-- name's uniqueness does, and not added while 200 views, the most there can
-- be, exist. Its list is the impact filter alone, every part stored as saved
-- views store one.
INSERT INTO saved_views (name, view, created_at, notifies)
SELECT name, '<the starting list>', unixepoch() * 1000, 1
FROM (
  WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
  SELECT IIF(i = 1, 'Blocking asks', 'Blocking asks ' || i) AS name, i FROM n
)
WHERE name COLLATE NOCASE NOT IN (SELECT name FROM saved_views)
  AND (SELECT count(*) FROM saved_views) < 200
ORDER BY i
LIMIT 1;

-- The devices the operator turned notifications on for: each browser push
-- subscription, by the endpoint its push service issued, with the keys that
-- encrypt to it, which are secrets the server holds. A subscription goes with
-- the passkey that signed its device in. session_hash is the SHA-256 of the
-- browser session that registered or last refreshed it, with no foreign key,
-- so the session expiring leaves it; signing that session out removes it.
-- One browser session holds at most one. label is what the device reported
-- of its browser and platform. accepted_at is when a push service last
-- accepted a send to it.
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 1 AND 2048),
  p256dh BLOB NOT NULL CHECK (length(p256dh) = 65),
  auth BLOB NOT NULL CHECK (length(auth) = 16),
  passkey_id INTEGER NOT NULL REFERENCES passkeys (id) ON DELETE CASCADE,
  session_hash BLOB NOT NULL UNIQUE CHECK (length(session_hash) = 32),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER
) STRICT;
CREATE INDEX push_subscriptions_passkey ON push_subscriptions (passkey_id);

-- The message of the thread that last notified the operator, which the
-- server sets on the operator's own marks, never the operator. Raising the
-- read or archive mark to it or past it clears it, as does a send no device
-- accepted.
ALTER TABLE thread_marks ADD COLUMN notified_seq INTEGER CHECK (notified_seq >= 1);

-- The server's push signing key, the P-256 private scalar, made by the first
-- agention serve that finds none, after which it never changes: every
-- device's subscription is bound to its public half.
ALTER TABLE instance ADD COLUMN vapid_private_key BLOB
  CHECK (length(vapid_private_key) = 32);
CREATE TRIGGER instance_vapid_key_fixed BEFORE UPDATE OF vapid_private_key ON instance
WHEN old.vapid_private_key IS NOT NULL
  AND new.vapid_private_key IS NOT old.vapid_private_key
BEGIN
  SELECT RAISE(ABORT, 'a server''s push key never changes');
END;
```

Notes on the constraints:

- A view notifies or does not, and the rules need no bound of their own: saved views' 200 bounds
  them (agention#184, `packages/api/src/saved-views.ts:23`). Two views of the same filters may both
  notify; their threads notify once all the same (FRD N1).
- E2 keeps which views notify off the operator API. Every saved views read names its columns,
  `id, name, view` (agention#184, `apps/server/src/store/saved-views.ts:24-44`, `:62`, `:75`), so
  adding `notifies` changes no answer of theirs, and a test holds that a view listed through the
  operator API carries no such field.
- `'<the starting list>'` is `JSON.stringify(threadsView.parse({ impact: "blocking" }))` on the base
  the migration lands on, written out in its text, since a frozen migration never changes. The
  migration's test holds that the stored list reads back through `readView` equal to that parse. A
  later change to the list's view that would refuse it ships with a migration rewriting the stored
  views, as review check A19 asks of every saved view (agention#184). Such a migration also sets
  `notifies` to 0 for a view its rewrite gives a refused filter, since only On and Replace keep that
  none has one on; A19 says so (PR 2's review checklist change).
- At most 199 views exist when the view is inserted, so at most 199 names are taken and one of the
  first 200 is free. `x COLLATE NOCASE NOT IN (...)` compares as the `name` column's `UNIQUE` does,
  so a view named "blocking ASKS" makes the starting view "Blocking asks 2".
- `session_hash` is `UNIQUE`: a browser session is one browser, so it holds at most one
  subscription, and Settings mark "this device" as the one the browser session holds, so no endpoint
  travels in a URL.
- `thread_marks` is `STRICT, WITHOUT ROWID` (`migrations.ts:323-329`); SQLite allows `ADD COLUMN`
  with a `CHECK` on both. Its comment there is in migration 1, which has shipped, so the new
  column's comment lives in this one.
- `instance` follows its `name` column's pattern, the one-way trigger included
  (`migrations.ts:87-101`).
- The cap of 10 subscriptions is checked in the store with a typed error, as the API keys' cap is
  (`apps/server/src/auth/api-keys.ts:132-142`), and tested.

## Rules

### The refused filters

In `packages/api/src/notifications.ts`, beside the list's filters
(`packages/api/src/thread-lists.ts:235-252`, `threadFilters` at `:269`):

```ts
// The filters that keep a saved view from notifying while they are on:
// search, since a notification never acts on what messages say, and overdue
// and the agent's reading, which change with time alone (FRD R1). Unread and
// including archived threads are not among them, since every agent message
// leaves its thread unread and not archived.
const refusedFilters = ["search", "overdue", "agent_read"] as const;
export type NotifyRefusedFilter = (typeof refusedFilters)[number];

// refusedFiltersOn names the refused filters a list has on. A saved view is
// stored whole, so a filter at its default is present but off: overdue is
// on only when true, search and agent_read whenever set.
export function refusedFiltersOn(filters: ThreadFilters): NotifyRefusedFilter[] {
  return refusedFilters.filter((name) =>
    name === "overdue" ? filters.overdue : filters[name] !== undefined,
  );
}
```

- The server refuses and ends a view's notifying by it, and the web UI names the filter that keeps a
  view's Notify switch off by it, so the two never disagree. Only the function and the type are
  exported, so nothing reads the list apart from it.
- `threadsView` holds every filter of `threadFilters` (agention#184,
  `packages/api/src/thread-lists.ts:275-280`), so a saved view's list is passed as it is.

### Turning notifying on and off

In `store/notifications.ts`, each a transaction that starts with `signedInSession`, as the
subscriptions' do. Neither needs a recent sign-in.

- **On** (`notifyView`): reads the view's row, `not_found` with field `view` when there is none,
  through `readView` (agention#184, `apps/server/src/store/saved-views.ts:38`, exported for this),
  and refuses a view with a refused filter on as `invalid_input` with field `view`, naming the first
  ("its search is on, and a view with search on cannot notify"). Then
  `UPDATE saved_views SET notifies = 1 WHERE id = :view`. Turning on a view that already notifies
  changes nothing.
- **Off** (`stopNotifying`): `UPDATE saved_views SET notifies = 0 WHERE id = :view`, `not_found`
  with field `id` only when no saved view has that id. Turning off a view that does not notify
  changes nothing.

### What saved views' writes do to notifying

- **Replace**: `replaceSavedView` (agention#184, `saved-views.ts:131-146`) turns `notifies` off in
  its own update when the new list has a refused filter on:

  ```ts
  const replaced = db
    .prepare("UPDATE saved_views SET view = ?, notifies = IIF(?, 0, notifies) WHERE id = ?")
    .run(JSON.stringify(input.view), refusedFiltersOn(input.view).length > 0 ? 1 : 0, id);
  if (replaced.changes !== 1) throw notFound("id");
  ```

  Both mounts run the same handler (agention#184, `docs/architecture.md`'s scopes). It is the write
  across resources under `saved-views:write` that review check A18 records beside the tag rename's,
  and `replaceSavedView`'s comment says so, as `renameTagInSavedViews`'s says its own
  (`saved-views.ts:158-164`).

- **Remove**: `removeSavedView` (`saved-views.ts:150-156`) deletes the view, and its notifying with
  the row; its comment says that removing a view that notifies ends its notifying.
- **Rename** and the tag rename (`renameTagInSavedViews`, `:165-178`) write only the name or the
  list, so the view keeps notifying, and a renamed tag keeps what it matches.

## The check

### Where it runs

Both agent write paths call it after their transaction commits, beside the wake of long polls:
thread start (`apps/server/src/store/threads.ts:534-536`) and message append (`:659-661`). Only an
agent's write, which is an identity authenticated by a registration
(`apps/server/src/identity.ts:14-17`):

```ts
if (outcome.appended) {
  store.notifier.notify(outcome.sessionId);
  if (identity.credential.kind === "registration") {
    store.afterAgentMessage({ threadId: outcome.threadId, seq: outcome.result.seq });
  }
}
```

- Both outcomes gain `threadId`: `addThread` has it as `id` (`threads.ts:518-523`), `sendMessage` as
  `thread.id` (`:589-657`). A replay (`appended: false`) never notifies.
- `Store` (`apps/server/src/store/store.ts:15-22`) gains
  `afterAgentMessage(message: { threadId: number; seq: number }): void`. `createStore` defaults it
  to doing nothing, which every store test and `agention passkey-link` (`cli.ts:415`) keep;
  `agention serve` passes the one that runs the check and hands its result to the sender
  (`cli.ts:323`). The store itself does no network work and no logging.
- It never throws into the write: the server's implementation wraps the check in `try`, logs a
  failure with the thread's id, and returns. The agent's answer is the write's, unchanged.
- `SessionNotifier.notify` is not the hook: revocations call it too
  (`apps/server/src/store/notifier.ts:11-14`).

### The statement

The check asks the operator's list whether it would keep this thread under a notifying view's
filters: the list's own total, scoped to the thread. `totalOf`
(`apps/server/src/store/thread-lists.ts:554-560`) takes its scope as a parameter, the list's reach
(`reached`, `:226-227`) by default, and the check passes the scope `readThread` already gives
`threadsSeen` for one thread (`apps/server/src/store/thread-reads.ts:375`):

```ts
// totalOf counts the threads a query's list holds, of those scope admits:
// by default every session the viewer reaches.
function totalOf(reach: Reach, query: ThreadFilters, scope = reached): number {
  const { total } = listStatement(
    reach.db,
    `${threadsSeen(scope, leadOf(query, defaultSort))}
     SELECT count(*) AS total FROM seen th WHERE ${where(query)}`,
  ).get({ ...reach.scope, ...parametersOf(query, reach.viewing, reach.now) }) as { total: number };
  return total;
}

// threadKept says whether the operator's list, under these filters, keeps
// the thread. The caller runs it in its transaction.
export function threadKept(
  store: Store,
  threadId: number,
  viewer: number,
  filters: ThreadFilters,
  now: number,
): boolean {
  const reach = { db: store.db, viewing: viewerAndCutoff(store, viewer, now), now };
  return totalOf({ ...reach, scope: { thread: threadId } }, filters, "t.id = :thread") > 0;
}
```

- `where` (`:171-174`), `leadOf` (`:196-198`), `parametersOf` (`:233-253`), and `listStatement`
  (`:259-263`) stay private to the list, and no part of the statement is written twice.
- `filters` is the view as `readView` gives it, passed as it is: a `ThreadsView` is a
  `ThreadFilters` with `sort`, `reverse`, and `group` beside, and `where`, `parametersOf`, and
  `leadOf` read only the filters, so order and grouping play no part (FRD R1). `unread` and
  `include_archived` run as the list runs them: the agent's message leaves the thread unread for the
  operator, and not archived, since a thread is archived only while the mark reaches its latest
  message (`thread-reads.ts:201`), so neither changes a match.
- `leadOf` matters: with a filter on asks on, the list keeps only a thread leading with an open ask
  that meets every one (`thread-lists.ts:147`, `askKeeps` at `:158-163`), and the lead comes from
  `threadsSeen`'s `placed` CTE (`thread-reads.ts:141-149`). A thread leads with such an ask whenever
  it holds one, and the order only picks which (`leadOf` at `:196-198`), so the check's
  `defaultSort` keeps the same threads as the view's own order would.
- `listStatement` allows the parameters a query does not name (`thread-lists.ts:255-263`), so the
  unused ones `parametersOf` binds are harmless, as they are in the list.
- The viewer is the operator's actor, from `findOperator`
  (`apps/server/src/store/directory.ts:15-25`), the audience of every agent thread
  (`threads.ts:557`).

### Its transaction

`checkNotification(store, { threadId, seq })` in `store/notifications.ts`, one transaction:

1. `SELECT count(*) FROM push_subscriptions`; none: return nothing, and set no mark, so a device
   turned on later is not denied a thread already marked.
2. `SELECT notified_seq FROM thread_marks WHERE actor_id = :operator AND thread_id = :thread`; set:
   return nothing. It notified since the operator last read or archived it (FRD N1).
3. Read the views that notify, `SELECT view FROM saved_views WHERE notifies ORDER BY id`, each
   through `readView`, and run `threadKept` with each until one keeps the thread, skipping one with
   a refused filter on (`if (refusedFiltersOn(view).length > 0) continue;`), which On and Replace
   already keep from notifying. None: return nothing. `threadKept` works out the viewer's cut-off on
   each call; the check may work it out once instead.

4. Set the mark:

   ```sql
   INSERT INTO thread_marks (actor_id, thread_id, notified_seq) VALUES (:operator, :thread, :seq)
   ON CONFLICT (actor_id, thread_id) DO UPDATE SET notified_seq = excluded.notified_seq
   ```

   A new row takes `read_seq` and `archived_seq` at their default 0, which is what a missing row
   means today (`thread-reads.ts:119-120`).

5. Read the thread with `readThread(store, threadId, operator, now)` and the subscriptions'
   `id, endpoint, p256dh, auth`, and return the payload and the subscriptions.

`seq` is the agent's message, which is the thread's latest: the write committed it and nothing ran
between, since the store is synchronous and the hook runs straight after the commit.

The reason the payload gives (`why`) comes from the thread's open asks as `readThread` summarizes
them (`packages/api/src/threads.ts:518-527`): `blocking` when any open ask blocks, else `urgent`
when the highest priority is urgent, else `open` while any is open, else `message`.

### The mark cleared

The operator reads or archives through the notified message, and the mark clears (FRD N1, R2):

- `raiseReadMark` (`apps/server/src/store/threads.ts:158-164`), which every read writer calls
  (`markRead` and `bulkRead` through `readThrough`, `apps/server/src/store/marks.ts:44-56`, and the
  operator's actions on many threads, `apps/server/src/store/thread-actions.ts:58` and `:89`) and so
  does a writer's own message (`threads.ts:278`):

  ```sql
  INSERT INTO thread_marks (actor_id, thread_id, read_seq) VALUES (?, ?, ?)
  ON CONFLICT (actor_id, thread_id) DO UPDATE
    SET read_seq = max(read_seq, excluded.read_seq),
        notified_seq = IIF(notified_seq <= max(read_seq, excluded.read_seq), NULL, notified_seq)
  ```

- `archiveFound`'s upsert (`marks.ts:165-169`), the same with `archived_seq`. `archiveThread` and
  `bulkArchive` reach it through `archiveThrough`, and the actions on many threads directly
  (`thread-actions.ts:53`).

In an `UPDATE ... SET`, every right-hand side reads the row as it was, so both terms use the old
mark; a `NULL` `notified_seq` compares as unknown and stays `NULL`. Only the operator's rows ever
hold a mark, so the agents' rows are unchanged. The operator replying clears it too, since their
message raises their read mark through it (`threads.ts:278`). `markUnread`, and the actions on many
threads marking unread, lower the read mark with `lowerReadMark` (`marks.ts:77-82`), which leaves
the mark alone: it was cleared when the thread was read, so the next agent message after marking
unread notifies again. `keepArchived` (`threads.ts:170-176`) moves only the writer's own archive
mark and needs no change.

## Push keys and the token

### The key

`agention serve` settles the key before the server listens, beside where it reads the name
(`cli.ts:318-323`), with the race-safe update `storeName` uses (`store/server-name.ts:25-33`):

```sql
UPDATE instance SET vapid_private_key = coalesce(vapid_private_key, :candidate)
WHERE id = 1 RETURNING vapid_private_key
```

- The candidate is the `d` of a fresh `generateKeyPairSync("ec", { namedCurve: "P-256" })` exported
  as a JWK: 32 bytes, fixed length. A start that loses the race takes the stored one.
- The public key is derived, never stored: `createECDH("prime256v1").setPrivateKey(d)`, then
  `getPublicKey()`, the 65-byte uncompressed point `0x04 || x || y`. Browsers take it as
  `applicationServerKey`, base64url.
- The private key becomes a `KeyObject` with `createPrivateKey({ key: jwk, format: "jwk" })`, where
  the JWK is `{ kty: "EC", crv: "P-256", d, x, y }` with `x` and `y` the two 32-byte halves of that
  point: Node 24 refuses a JWK holding `d` alone (`ERR_CRYPTO_INVALID_JWK`).
- Read back, the key is persisted state: its length is checked by the column, and deriving its point
  and `KeyObject` checks the rest; a failure stops the server with a message that names no key
  material. The key never leaves the sender. No log line prints it, and no route answers it.

### The token and its cache

`jose` is already a pinned dependency of the server bundle (`apps/server/package.json:37`, used at
`apps/server/src/auth/agent-tokens.ts:7`). The sender signs RFC 8292 tokens with it:

```ts
const jwt = await new SignJWT({ sub: "https://github.com/WayfarerLabs/agention" })
  .setProtectedHeader({ alg: "ES256", typ: "JWT" })
  .setAudience(audience)
  .setExpirationTime(Math.floor((now + 12 * hour) / 1000))
  .sign(privateKey);
const authorization = `vapid t=${jwt}, k=${publicKeyBase64url}`;
```

- `audience` is the endpoint's origin, `new URL(endpoint).origin`.
- `sub` is the project's repository URL, as `apps/server/package.json:6-8` names it, so the token
  names neither the operator nor the server's host. It is an `https:` URL, which Apple requires.
- The cache is a `Map<string, { authorization: Promise<string>; renewAt: number }>` keyed by
  audience, in the sender, so in memory and per process. It holds the signing's promise, so the
  parallel sends of one notification to two devices on one push service sign once. A cached value is
  reused until `renewAt`, an hour before its expiry: 11 hours of reuse, never a new token for an
  audience more often than once an hour within one process, which is Apple's rule (research 2.2),
  and never one within an hour of expiring. A signing that rejects is removed from the cache. The
  key never changes, so the cache needs no other key.
- The cache is not persisted, so it cannot limit signing across restarts: each start signs a new
  token at its first send to an audience, and a server restarted more often than once an hour signs
  more often than Apple asks. Restarts are an operator's act and rare, so the design accepts that
  rather than storing tokens.

## The payload and its size

### Fields

The plaintext is one JSON object, in `packages/api/src/notifications.ts` as `pushPayload`, a plain
`z.object`, so the service worker that reads it ignores a field it does not know:

| Field     | Value                                             | Largest, in UTF-8 |
| --------- | ------------------------------------------------- | ----------------- |
| `agent`   | the agent's name                                  | 63 bytes          |
| `session` | the session's name                                | 63 bytes          |
| `thread`  | the thread's number                               | 16 bytes          |
| `title`   | the thread's title                                | 800 bytes         |
| `why`     | `"blocking"`, `"urgent"`, `"open"` or `"message"` | 8 bytes           |

- Names are 1 to 63 of `a-z`, `0-9`, `_` and `-` (`packages/api/src/names.ts:7-8`), so they need no
  escaping in JSON.
- The thread number is a safe integer (`packages/api/src/bounds.ts:5-8`), at most 16 digits.
- The title is 1 to 200 code points (`packages/api/src/threads.ts:67`), well formed
  (`packages/api/src/text.ts:31-34`) and without control characters (`text.ts:21`), so
  `JSON.stringify` escapes nothing but `"` and `\`, 2 bytes each. Every other code point is at most
  4 bytes, so the title is at most 800 bytes in the JSON.
- `why` is words for the service worker to choose, not text it shows as given.
- No message text, ever (FRD D5). No time: the notification's own timestamp is when it shows.

The largest payload, every field at its largest, is **1005 bytes** of JSON (computed with
`JSON.stringify` and `Buffer.byteLength` on 200 U+10FFFF characters, two 63-character names and
`Number.MAX_SAFE_INTEGER`). The smallest is 63.

### One padded size

- An `aes128gcm` push message is one record. Its plaintext is the data, a delimiter octet `0x02`,
  then zero octets of padding (RFC 8188 section 2; RFC 8291 section 4).
- The body is the 86-octet header (16 salt, 4 record size, 1 key id length, 65 key id) plus the
  record's plaintext and its 16-octet tag (research 1.1).
- The smallest limit in the research is Mozilla's 2744 bytes through its FCM bridge (research 1.3);
  every other is 4096 bytes of body, which is 3993 octets of plaintext.
- **The record's plaintext is always 1024 octets**: the data, `0x02`, and `1023 - length(data)` zero
  octets. Data of up to 1023 bytes fits; the largest payload is 1005, which leaves 18 bytes over the
  largest possible fields.
- **Every body is 1126 bytes**: 86 + 1024 + 16, under the 2744-byte limit by more than half, and the
  same whatever the title.
- The sender refuses data over 1023 bytes as an internal error rather than sending a longer record,
  which would leak the length. The payload's own test builds the largest payload and checks it fits,
  so a field added later that could break the size fails that test, not a send.

## `aes128gcm` on `node:crypto`

RFC 8291 section 3 with RFC 8188's content coding, in `push/encryption.ts`. Inputs are the
subscription's `p256dh` (`ua_public`, 65 octets) and `auth` (`auth_secret`, 16 octets), and the
padded record above.

1. Make the message's own key pair: `ecdh = createECDH("prime256v1")`, `ecdh.generateKeys()`;
   `as_public` is `ecdh.getPublicKey()`, 65 octets uncompressed.
2. `ecdh_secret = ecdh.computeSecret(ua_public)`, 32 octets. It throws on a point not on the curve,
   which the route has already refused (below), so here it is an internal error.
3. `key_info = "WebPush: info" || 0x00 || ua_public || as_public`.
4. `ikm = hkdfSync("sha256", ecdh_secret, auth_secret, key_info, 32)`: HKDF with `auth_secret` as
   its salt (RFC 8291 section 3.3).
5. `salt = randomBytes(16)`.
6. `cek = hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm" || 0x00, 16)`.
7. `nonce = hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce" || 0x00, 12)`. There is one
   record, sequence number 0, so the nonce is used as derived (RFC 8188 section 2.3).
8. `cipher = createCipheriv("aes-128-gcm", cek, nonce)`; `ciphertext = cipher.update(record)`, then
   `cipher.final()`, then `cipher.getAuthTag()`, 16 octets.
9. `header = salt || uint32be(4096) || 0x41 || as_public`: the record size 4096 is the largest a
   record may be, not its length, and the same for every message; `0x41` is 65, the key id's length.
10. The body is `header || ciphertext || tag`, sent with `Content-Encoding: aes128gcm` and
    `Content-Type: application/octet-stream`.

`hkdfSync` returns an `ArrayBuffer`; each result is wrapped in a `Buffer`. The steps take the
message's key pair and salt as inputs to an inner function, which the public one calls with fresh
ones; the test calls the inner one with RFC 8291 Appendix A's sender key pair, salt and subscription
keys, a record of the example's plaintext and its delimiter with no padding, and checks the body
byte for byte against the appendix, copied into the test from the RFC as published.

## The endpoint rule

One pure function in `push/endpoint.ts`, which the route runs on registration and the sender again
before each send. It never resolves a name: HTTPS and the push service's certificate bind it, as the
transcription base URL rule reasons (`apps/server/src/transcription/base-url.ts:4-13`).

```ts
// The push services' hosts: those exactly, and any host under those with a
// leading dot, matched at a dot boundary.
const pushHosts = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.apple.com"];
const pushDomains = [".push.apple.com", ".notify.windows.com"];

export const maxEndpointLength = 2048;

// endpointProblem says why the server will not send to an endpoint, or
// nothing when it will: an absolute https: URL, at most 2048 characters, on
// the default port, with no user information, whose host is a known push
// service's.
export function endpointProblem(endpoint: string): string | undefined {
  if (endpoint.length > maxEndpointLength) {
    return `must be at most ${maxEndpointLength} characters`;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "must be an absolute https: URL";
  }
  if (url.protocol !== "https:") {
    return "must be an https: URL";
  }
  if (url.port !== "") {
    return "must use the default port";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not carry a user name or password";
  }
  const host = url.hostname;
  const known = pushHosts.includes(host) || pushDomains.some((domain) => host.endsWith(domain));
  return known ? undefined : "is not a push service this server sends to";
}
```

- The WHATWG parser lowercases the host and writes `:443` as no port for `https:`, so `port !== ""`
  refuses every other port.
- A trailing dot (`fcm.googleapis.com.`) and a look-alike (`fcm.googleapis.com.evil.test`,
  `evilpush.apple.com`) match neither list. An IP literal matches neither.
- Its test is a table of endpoints, each accepted or refused: one real-shaped endpoint per service,
  every refusal above, and the look-alike hosts. It asserts whether a problem is returned, never the
  problem's words.

## The sender

`push/sender.ts` takes the private key, the store, the log, the shutdown signal and a transport,
`(url: string, init: RequestInit) => Promise<Response>`, which is `fetch` in `agention serve` and a
local test push service in the tests.

### Each try

For each subscription the check returned, in parallel, each try of the schedule below:

1. Check the endpoint again with `endpointProblem`; a problem fails it at once (a row from before a
   rule change).
2. Take the token for the endpoint's origin from the cache, signing it if needed.
3. Check, in one read of the store, that the try is still wanted (below); if not, cancel it and
   every later try for this subscription.
4. Encrypt the payload for the subscription's keys.
5. `POST` to the endpoint with:
   - `Authorization`: the cached token for the endpoint's origin;
   - `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`;
   - `TTL: 86400`, one day;
   - `Urgency: high`;
   - no `Topic`, which travels in clear (research 1.1);
   - `redirect: "manual"`, so a redirect is answered as it is and never followed, as the
     transcription provider does (`apps/server/src/transcription/provider.ts:168-176`);
   - a signal of `AbortSignal.any([shutdown, AbortSignal.timeout(10_000)])`, as the provider
     combines its own (`provider.ts:153-154`).
6. Cancel the response body unread.

### Still wanted

The check returned the subscriptions as they were when it committed, and a try can start up to a
minute later. Before each try, `stillWanted(store, { subscription, threadId, seq })` in
`store/notifications.ts` reads:

```sql
SELECT 1 FROM push_subscriptions
WHERE id = :id AND endpoint = :endpoint AND p256dh = :p256dh AND auth = :auth;
SELECT 1 FROM thread_marks
WHERE actor_id = :operator AND thread_id = :thread AND notified_seq = :seq;
```

- The first finds no row when the device was removed, signed out, or lost its passkey meanwhile, so
  nothing reaches a device whose notifications have ended (FRD D3); or when **On** or **Refresh**
  gave the row other keys or another endpoint, which the browser now holds instead.
- The second finds no row when the operator read or archived the thread through this message, or a
  later message notified: a late try would alert for what was read, or replace the newer
  notification of the same `tag` with this older one.
- A cancelled try sends nothing and counts as one no push service accepted. It is not logged: the
  operator's own change caused it.
- Steps 3 to 5 run with no `await` between the read and the transport's call, and the store is
  synchronous, so no request can change either row between the read and the request starting. The
  token's signing, the one wait, comes before the read.
- A request already started cannot be recalled: a device removed while a try is in flight may still
  show that one notification. Removal stops every try not yet started.

### Outcomes

| Answer                     | Outcome                               |
| -------------------------- | ------------------------------------- |
| 200, 201, 202              | accepted: `accepted_at` is set to now |
| 404, 410                   | gone: the subscription is deleted     |
| 429, 500 to 599, a timeout | retried, below                        |
| a failure of `fetch`       | retried, below                        |
| any other                  | failed, logged with its status        |

The log line names the subscription's id, the endpoint's host and the outcome, such as
`push to device 3 (fcm.googleapis.com) failed: 403`. It never prints the endpoint's path, which is
the secret part, nor the keys or the token.

### The retry schedule

- At most three tries: the first at once, the second 10 seconds after the first ends, the third 45
  seconds after the second ends. A push service's `Retry-After` is not read.
- With the 10-second timeout, the longest a send can take is 10 + 10 + 10 + 45 + 10 = 85 seconds.
- Waits use `setTimeout` from `node:timers/promises` with the shutdown signal, so stopping the
  server ends them, as it aborts sends in flight.

### After every subscription settles

- If none accepted, the mark is cleared when it still names this message, so the thread's next agent
  message tries again:

  ```sql
  UPDATE thread_marks SET notified_seq = NULL
  WHERE actor_id = :operator AND thread_id = :thread AND notified_seq = :seq
  ```

- If the operator read the thread meanwhile, the mark is already clear and this changes nothing; if
  a later message notified, the mark names that one and this changes nothing. In both cases the
  tries not yet started were cancelled.
- Each of these writes, and `accepted_at` and the deletes, is its own small transaction. A row
  deleted meanwhile is simply not updated.

### Stopping

- The sender keeps the notifications whose sends have not all settled. On the shutdown signal's
  `abort`, which `agention serve` fires (`cli.ts:375`) before it closes the database (`:381`), a
  listener runs synchronously and clears the mark of each, with the statement above. A notification
  the server stopped in the middle of is treated as one no device accepted, so the thread's next
  agent message notifies.
- A crash, or a kill the server cannot see, runs no listener: a thread whose send was in flight
  keeps its mark, and stays silent until the operator reads or archives it. Nothing finds or retries
  such a send, which is the price of having no durable queue.

## Subscriptions

All in `store/notifications.ts`, each a transaction that starts with
`signedInSession(db, identity, now)` (`apps/server/src/auth/browser-sessions.ts:147-165`), which
confirms the browser session and gives its passkey and whether the sign-in is recent.

- **On**: needs a recent sign-in (`requireRecentSignIn`, `browser-sessions.ts:168-175`). With the
  endpoint already stored, it updates that row's keys, label, passkey and session hash. Otherwise it
  replaces the row this browser session already holds, if any, with the new endpoint and keys, or
  inserts a row while fewer than 10 are stored.
- **Refresh**: needs no recent sign-in, and only updates a row whose endpoint the server stores: its
  keys, label, passkey and session hash. That is how a second sign-in on the same browser moves the
  subscription to its new session. An endpoint the server does not store is `not_found`, and the web
  UI stops this device's notifications, as below.
- **Moving a row to a session that holds another**: both On and Refresh, when they give a row the
  current session's hash while another row holds it, delete that other row first, in the same
  transaction, so `UNIQUE` never fails. The other row was this browser's older subscription.
- **Orphans**: a row whose browser no longer holds its subscription ends when its push service
  answers 404 or 410 to a send, when **On** from the session that holds it replaces it, or when the
  operator removes it from the list.
- **Remove**: deletes a row by id. Removing this browser session's own row is turning this device
  off, and needs no recent sign-in; removing any other device's needs one, as revoking an API key
  does (FRD D3).
- **Sign-out**: `signOut` (`browser-sessions.ts:81-86`) deletes the row whose `session_hash` is the
  closing session's, in the same transaction. Not `closeBrowserSession`
  (`browser-sessions.ts:67-77`), which a new sign-in on the same browser also calls
  (`apps/server/src/auth/passkeys.ts:202`): that one must leave the row for the next refresh to
  move.
- **Passkey removal**: removing one (`apps/server/src/auth/operator-passkeys.ts:75`) or replacing
  them all by a passkey link (`passkeys.ts:440`) deletes its subscriptions by the cascade.
- **Expiry** of a browser session deletes the session row only (`browser-sessions.ts:24-28`); the
  subscription has no foreign key to it, so it stays (FRD D3, ruling 5).

The keys arrive as base64url and are stored as their bytes. `p256dh` must decode to 65 octets and be
a point on P-256, which the route checks by `createECDH("prime256v1").computeSecret(p256dh)` on a
throwaway key; `auth` must decode to 16 octets.

## Routes

On the web API only, beside the API keys' (`apps/server/src/http/web-api.ts:233-240`), each behind
`requireSession` (`:119-122`), which checks the session and, for a change, its CSRF token and origin
(`:97-117`). None is an operation, so none reaches the operator API (`addOperations` at `:249-254`
is where operations go). They follow the web routes' shape: a `GET` for the page's state, and `POST`
for each change, a removal by id as `POST /:id/remove` like the passkeys' (`:208-214`). Bodies are
read with `parseBody` and ids with a helper like `passkeyOf` (`apps/server/src/http/input.ts:42-61`,
`:65-71`). Errors are the API's one shape (`packages/api/src/errors.ts:6-39`, body at `:54-63`).

Every route answers `unauthenticated` (401) without a live session, and every `POST` answers it for
a missing or wrong CSRF token or origin, as every web route does.

### `GET /api/web/notifications`

The Settings page's state.

```json
{
  "public_key": "BM4...",
  "recent": true,
  "devices": [
    {
      "id": 3,
      "label": "Chrome on Android",
      "created_at": "2026-11-23T10:00:00.000Z",
      "accepted_at": "2026-11-23T11:02:13.000Z",
      "current": true
    }
  ],
  "notifying": [1]
}
```

- `public_key`: the VAPID public key, base64url, which the browser subscribes with.
- `recent`: whether this browser's sign-in is recent, so Settings can say that turning a device on
  and removing another device need one, as the API keys' list does
  (`packages/api/src/api-keys.ts:85`).
- `current`: the device whose subscription this browser session holds; at most one is.
- `accepted_at` is absent until a push service first accepts a send.
- `notifying`: the ids of the saved views that notify, at most 200. Settings' Saved views set each
  row's Notify switch from it, and the thread list's Saved views sheet reads it for Replace's
  question.

### `POST /api/web/notifications/devices`

**On**: registers this device's subscription.

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": { "p256dh": "BNc...", "auth": "tBH..." },
  "label": "Chrome on Android"
}
```

Answers `{ "device": { ... } }`, the device as the list shows it. Errors:

| Code            | Field         | When                                                    |
| --------------- | ------------- | ------------------------------------------------------- |
| `invalid_input` | `endpoint`    | the endpoint rule's problem                             |
| `invalid_input` | `keys.p256dh` | not base64url of 65 octets, or not a point on P-256     |
| `invalid_input` | `keys.auth`   | not base64url of 16 octets                              |
| `invalid_input` | `label`       | not one line of 1 to 60 characters                      |
| `invalid_input` | none          | a new device while 10 are on: "remove one first"        |
| `not_allowed`   | none          | no recent sign-in, `requireRecentSignIn`'s (`:168-175`) |

### `POST /api/web/notifications/devices/refresh`

**Refresh**: the same body, the same answer. Errors: those of **On** but the cap and `not_allowed`,
and `not_found` with field `endpoint` when the server does not store the endpoint.

### `POST /api/web/notifications/devices/:id/remove`

Answers `{}` (`done`, `packages/api/src/routes.ts:33`). `not_found` with field `id` for a device
that is not there; `not_allowed` for another device's without a recent sign-in.

### `POST /api/web/notifications/views`

**On** for a saved view: `{ "view": 4 }`, the view's id. Answers `{}`. Errors:

| Code            | Field  | When                                |
| --------------- | ------ | ----------------------------------- |
| `invalid_input` | `view` | not a saved view's id in its bounds |
| `invalid_input` | `view` | a refused filter on, named          |
| `not_found`     | `view` | no saved view has that id           |

### `POST /api/web/notifications/views/:id/remove`

**Off** for the saved view `:id`. Answers `{}`, also when the view does not notify. `not_found` with
field `id` only when no saved view has that id.

## The web UI

### The service worker

- **Source and build.** `apps/web/src/service-worker.ts`, built as one classic script in its own
  pass after the Vite build, as the diagram frame's is (`apps/web/build-frame.ts:1-26`), with
  `bundleScript` (`packages/build/src/bundle.ts:67-113`). That names its output
  `assets/<name>-<hash>` (`:76`), so it gains an option for a fixed name at the build's root.
- **Served at `/service-worker.js`.** The server serves the web build's files at `/`
  (`apps/server/src/http/web-ui.ts:80`), so the worker's default scope is `/`, the whole web UI, and
  no `Service-Worker-Allowed` header is needed. A fixed name keeps one registration across releases;
  every response already carries `Cache-Control: no-store` (`apps/server/src/http/app.ts:51-59`), so
  an update reaches browsers on their next check.
- **License notices.** The worker bundles `zod` and `@wayfarerlabs/agention-api` for the payload's
  schema, so its pass writes the packages it includes to `dist/.vite/service-worker-notices.json`,
  as the frame's pass writes its own (`build-frame.ts:25-26`), and the server package ships them
  with the web UI's.
- **Registered** by the web UI at every start, from `main.tsx`, with
  `navigator.serviceWorker.register("/service-worker.js", { scope: "/" })` where the browser has
  `serviceWorker` and `PushManager`, so the registration exists for **On** and for refresh, and a
  new release's worker installs. Registering again with the same script and scope is no new
  registration.
- **Policy.** It has no `fetch` handler and caches nothing. It runs under the page's content
  security policy, whose `script-src 'self'` (`app.ts:42`) admits it; PR 1 states
  `worker-src 'self'` too. It loads nothing but its own origin's icon.

```ts
self.addEventListener("push", (event) => {
  event.waitUntil(show(event.data));
});

async function show(data: PushMessageData | null): Promise<void> {
  const read = pushPayload.safeParse(parsed(data));
  if (!read.success) {
    // A push must always show something, or browsers revoke the permission.
    return self.registration.showNotification("Agention", { body: "Something needs you" });
  }
  const { agent, session, thread, title, why } = read.data;
  return self.registration.showNotification(title, {
    body: whyWords[why],
    tag: `${agent}/${session}/${thread}`,
    renotify: true,
    data: { agent, session, thread },
    icon: "/icons/192.png",
  });
}
```

- `whyWords` maps `blocking`, `urgent`, `open` and `message` to "Blocking ask", "Urgent ask", "Open
  ask" and "New message".
- `tag` is the thread, so a later notification for it replaces the earlier where the browser honors
  tags (FRD N1); `renotify` makes the replacement alert, which is right because a thread notifies
  again only after it was read.
- `parsed` is `JSON.parse` of `data.text()` in a `try`; anything that fails is the generic
  notification.

### Opening the thread

```ts
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(open(openTarget.safeParse(event.notification.data)));
});

async function open(target: ReturnType<typeof openTarget.safeParse>): Promise<void> {
  const path = target.success
    ? threadHref(target.data.agent, target.data.session, target.data.thread)
    : "/";
  const windows = (
    await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  ).filter(showsWebUi);
  const client = windows.find((each) => each.focused) ?? windows[0];
  if (client !== undefined) {
    await client.focus();
    if (target.success) {
      client.postMessage({ type: "open-thread", ...target.data });
    }
    return;
  }
  await self.clients.openWindow(new URL(path, self.location.origin).href);
}

// showsWebUi says whether a window is the web UI, whose page listens for
// open-thread, rather than another page of this origin.
function showsWebUi(client: WindowClient): boolean {
  return matchRoute(new URL(client.url).pathname).name !== "not-found";
}
```

- `openTarget` is the payload's `agent`, `session`, and `thread` with their schemas. `threadHref`
  (`apps/web/src/router.tsx:325-327`) builds the route from the identifiers alone, never from a URL
  in the payload, and the result is always on the worker's own origin.
- **Only a web UI window is chosen.** `matchAll` with `includeUncontrolled` returns every window
  client of the worker's origin, controlled or not (W3C Service Workers, `Clients.matchAll`,
  <https://www.w3.org/TR/service-workers/#clients-matchall>), and nothing in a client says whether
  its page listens for `open-thread`. Not every page of the origin is the web UI: the API's
  documentation at `/docs/api/` is static HTML that runs no script
  (`apps/server/src/http/api-docs.ts:6-18`), and a tab can show an API answer or a file of the
  build. Each is a path the web UI's own router names `not-found`, so `showsWebUi` keeps the windows
  whose URL is a route of the UI, and when none is, the click opens a new window at the thread
  rather than telling a page that cannot hear it.
- The route table moves from `router.tsx` to `routes.ts`, which imports neither React nor the DOM,
  so the worker bundles it: the `Route` type (`router.tsx:16-26`), the two patterns `matchRoute`
  reads (`:28-30`), `matchRoute` (`:32-60`), and `threadHref` (`:325-327`). `router.tsx` re-exports
  none of them, so each name has one home: in the same change, every caller's import moves to
  `routes.ts`. Those are `App.tsx`, `App.test.tsx`, `views/ThreadList.tsx`, `views/Threads.tsx`,
  `views/list/ThreadRow.tsx`, `views/sessions/NewThreadSheet.tsx`, and `views/thread/leaving.ts`,
  all under `apps/web/src/`, and `router.tsx` imports `matchRoute` and `threadHref` for its own
  uses. The worker and the UI then share one route table.
- A web UI window already open is focused and told which thread to open, rather than navigated by
  URL: `Client.url` does not follow a single-page app's route changes everywhere (research Q6,
  "Click URLs"). Whichever URL a browser reports, it is a route of the UI, since the UI moves only
  between its own routes, which is all `showsWebUi` needs.
- A web UI window that loaded at an address the UI does not know, such as a mistyped link, reports
  that `not-found` URL in a browser that does not follow its later routes. It is passed over, and
  the click opens a new window, which still opens the thread.
- `focus()` and `openWindow()` are allowed here because a notification click gives the worker
  transient activation.
- `includeUncontrolled` finds a window the worker does not control, such as the first one after it
  installed; `Client.postMessage` reaches it all the same.

The page side, `apps/web/src/push/open-thread.ts`, installed once from `main.tsx` before the app
renders:

```ts
navigator.serviceWorker?.addEventListener("message", (event) => {
  const message = openThreadMessage.safeParse(event.data);
  if (message.success) {
    const { agent, session, thread } = message.data;
    navigate(threadHref(agent, session, thread));
  }
});
navigator.serviceWorker?.startMessages();
```

- `navigate` (`router.tsx:146-157`) pushes a history entry and announces it, so the shell renders
  the thread and moves focus to it as any navigation does. With no `from` in the entry's state, the
  thread returns to the list with no filters, as a thread opened any other way does
  (`router.tsx:196-199`).
- **It listens on every route of the UI.** Every path `showsWebUi` accepts gets the UI's page
  (`apps/server/src/http/web-ui.ts:6-8`), and so runs `main.tsx`, which installs the listener
  outside the shell and before it picks a view. The listener therefore runs on the sign-in and link
  pages, and while the session is loading or unreachable, so a click focusing a window that shows
  only the sign-in page is heard there and the click filter needs no exception for it.
- Signed out, the shell sends the thread's route to sign-in with `next`, and signing in comes back
  to it (`apps/web/src/App.tsx:50-64`), which is FRD D4's "signed in as usual".
- The message is checked with a schema built from the API's own `name` and thread number schemas; a
  message that fails is ignored. Only the origin's own service worker can post to it.
- Opening the thread reads it, which clears the mark.
- **Known limit: a tab on an older bundle.** The web UI does not reload when the server is upgraded.
  A tab opened before the release that adds this listener, or before a release that changes the
  message's shape, shows a route of the UI but runs a bundle that does not act on the message, so a
  click that focuses it is swallowed: the tab comes forward and the thread does not open. The limit
  is transient, lasting until that tab reloads, and the design adds no acknowledgment to detect it.

### Device intent, subscribe and refresh

- The intent is a device choice beside the others (`useDeviceChoice`,
  `apps/web/src/device.ts:72-84`), under `agention.notifications`.
- **On** (from Settings' switch, a tap, with a recent sign-in): `Notification.requestPermission()`;
  if the browser holds a subscription whose `options.applicationServerKey` is not the server's
  public key, `unsubscribe()` it first, since a browser refuses a second subscription under another
  key; then `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
  with the public key from `GET /notifications`, and `POST /notifications/devices` with
  `subscription.toJSON()`'s endpoint and keys and a label made from the browser and platform. The
  intent is kept only once the server accepted it.
- **Refresh** runs while the intent is set, on start and after an in-app sign-in:
  `getSubscription()`, then `POST /notifications/devices/refresh` with it. It never subscribes.
- **Stopped**: when refresh finds no subscription in the browser, one under another key, or one the
  server answers `not_found` for, the device's notifications have stopped: the browser dropped them,
  or another device removed this one, or a push service ended it. The web UI then unsubscribes in
  the browser, clears the intent, and Settings show this device's state as "Stopped", with which of
  those it was, beside "On", "Off" and "Blocked by the browser". Turning it on again is **On**, with
  a recent sign-in, as the first time was (FRD D3).
- **Off** and **sign-out**: `unsubscribe()` in the browser, the remove route for this device's own
  row (Off) or the sign-out route, which removes it, and the intent cleared.

### Settings and the saved views sheet

- **Settings, Saved views** (agention#184, `apps/web/src/views/settings/SavedViews.tsx`): each row
  gains a Notify switch beside Rename and Remove, on while `GET /notifications` lists the view, and
  turning it on or off posts the `views` routes. For a view with a refused filter on it is off and
  disabled, its description naming the filter by `refusedFiltersOn`, as the thread list's filters
  name it.
- **Remove's question** (`SavedViews.tsx:126-131`) says, for a view that notifies, that removing it
  ends its notifying.
- **Replace with this list's question** in the thread list's Saved views sheet
  (`apps/web/src/views/list/SavedViews.tsx:106-112`) says, for a view that notifies when the list on
  screen has a refused filter on, that replacing ends its notifying, naming the filter.
- **Settings, Notifications** keeps this device's switch and the device list, and says that which
  views notify is set in Saved views, linking there.

## Tests

As the HLA's Testing section lists them, with the shape this design gives them:

- **Encryption**: RFC 8291 Appendix A through the inner function, byte for byte; the public function
  always yields a 1126-byte body, for the smallest and the largest payload; data over 1023 bytes
  refused.
- **Token**: verified with `jose`'s `jwtVerify` against the derived public key, with its `aud`,
  `exp` and `sub`; two parallel first sends to one origin sign once; a send within 11 hours reuses
  the token, one after does not.
- **Payload**: the largest payload is 1005 bytes and fits.
- **Refused filters**: `refusedFiltersOn` naming each refused filter when on and not when at its
  default, and naming neither `unread` nor `include_archived` when on.
- **Rules**: On refusing a view with each refused filter on, naming it, and `not_found` for a view
  that is not there; On for a view that already notifies answering `{}`; Off answering `{}` for a
  view that notifies and for one that does not, and `not_found` for an id no saved view has; an API
  key holding `saved-views:write` replacing a notifying view's list, ending its notifying when the
  new list has a refused filter on and keeping it otherwise; removing the view ending it; a rename
  and a tag rename keeping it; a view listed through the operator API carrying no `notifies`.
- **Endpoint rule**: the table above, accepted or refused.
- **The check**: through the store with a recording `afterAgentMessage` sink and the real check: a
  notifying view keeps its thread and not a sibling in the session, for an ask filter and a name
  filter; the starting view; a removed session's name and a removed group; a view's order,
  direction, and grouping changing no match; a view with `unread` and one including archived threads
  matching; a replaced list matching from the next message; no device, no mark; the operator's own
  writes (browser session and API key) never reach the hook; a replay never notifies.
- **The mark**: notifies once; not again before the operator reads; again after a read or an archive
  through it, including after marking unread; a reply clears it; a read short of it leaves it.
- **Sender**, against a local test push service through the transport: headers, one body size, no
  redirect followed, the retry schedule with a fake clock (5xx, 429, timeouts), 404 and 410
  deleting, the mark cleared only when none accepted and only while it names the message, a slow
  service never delaying the agent's answer, and the shutdown signal clearing the mark of a send in
  flight. Stale tries, each with a first try answered 500: the device's row removed during the wait,
  and the row re-keyed by a Refresh during the wait, present but with other keys, each sending no
  second try; the thread read during the wait, then a later message notifying and accepted, then the
  wait ending, sending nothing for the older message. Sign-out and passkey removal need no case of
  their own, since the Subscriptions tests prove each deletes the row.
- **Subscriptions and routes**: each error in the tables; On needing a recent sign-in; Refresh
  updating a stored endpoint only, and `not_found` for any other; a refresh moving a subscription to
  a new session, deleting that session's older row; removing this device without a recent sign-in
  and another device only with one; sign-out removing it and a new sign-in not; passkey removal by
  both paths; expiry leaving it; the routes absent from the operator API.
- **Migration**: a database at the migration before this one holding threads, marks, an instance
  row, and saved views, migrated forward: its rows intact and not notifying, the starting view
  present once, notifying, with its list reading back through `readView` as
  `threadsView.parse({ impact: "blocking" })`, the new columns empty; with a view named "blocking
  ASKS", the starting view named "Blocking asks 2"; with 200 views, no view added; the key's trigger
  refusing a change.
- **Browser (Chromium)**: as the HLA says, with `push` and `notificationclick` delivered to the
  worker, a window already open receiving `open-thread` and showing the thread, and a refresh
  answered `not_found` showing "Stopped". A click with the API's documentation page focused beside a
  web UI window opens the thread in the web UI window, and one with only the documentation page open
  opens a new window at the thread. A click with only the sign-in page open, signed out, leaves that
  page on sign-in with `next` naming the thread.
