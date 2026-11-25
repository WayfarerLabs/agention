# Operator API

The operator API lets a program of yours do most of what you do in the web UI: read your agents'
threads, wait for new messages, answer asks, and approve sessions. It acts as you, within the scopes
of the [API key](operator-guide.md#api-keys) you give it.

This page says how to call it. Every operation, with its scope, parameters and answer, is in the
[reference](#reference), generated from the server's own operation declarations.

## Calling it

The operator API is at your origin under `/api/operator/v1/`.

- **Every request carries an API key** as a bearer token, `Authorization: Bearer agention_...`, and
  no cookie: a request carrying one is refused.
- **A key that is mistyped, revoked or expired** is refused as `unauthenticated`, status 401.
- **An operation outside the key's scopes** answers `not_found`, status 404, as if it did not exist.
- **A version changes only by additions**, so a program written against version 1 keeps working
  while the server serves it, as long as it ignores fields it does not know. Until 1.0, what a field
  or value means may also change within a version; the changelog marks each such change as breaking.
  `GET /api/operator` lists the versions the server serves.
- **Each key has a rate budget of its own** ([Rate budgets](operator-guide.md#rate-budgets)).

## Reference

To read the reference, start the server with `--api-docs`. It then serves the documentation at
`/docs/api/`, and the OpenAPI document for client generators at `/docs/api/openapi.json`; without
it, nothing is served under `/docs/api/`. Neither needs a sign-in, so anyone who reaches the origin
can read them; they describe the API, never your data. Both name this page as their guide. The same
document is in Agention's repository, at [`docs/api/openapi.json`](api/openapi.json).

## Reading and waiting

For example, in bash, with a key holding `sessions:read` and `threads:read`, read from a file only
you can read so it stays out of your shell's history:

```bash
origin=https://agention.example.com
key="$(cat ~/.config/my-tool/agention-key)"
auth() { printf 'Authorization: Bearer %s\n' "$key"; }
curl -sS -H @<(auth) "$origin/api/operator/v1/sessions"
curl -sS -H @<(auth) "$origin/api/operator/v1/wait?wait=25"
```

`-H @<(auth)` has curl read the header from a file that bash's own `printf` writes, which keeps the
key out of every command's arguments: anyone on the machine can read those in the process list while
the command runs.

The first request lists your agents with their sessions. Each session's `presence` says when its
agent last checked in (`last_seen_at`), whether it is quiet, and whether its bridge is `connected`,
absent for a bridge from before the background connection; while it is connected, `monitor` holds
what its bridge last reported of the terminal it runs in: whether it watches one at all and, if it
does, the session's `condition` and `since` when, what `stopped_by` it where the bridge can tell,
and the `profile` it reads the terminal with
([Monitoring a session's terminal](operator-guide.md#monitoring-a-sessions-terminal)). The second
answers at once with the threads, in any session, holding messages you have not read, each naming
its agent and session; with none, it waits up to 25 seconds for one. Its answer holds a `since`:
pass that back, as `wait?wait=25&since=...`, to hear only of newer messages. A program waiting in a
loop then hears of each new message once, as soon as it arrives, without polling. A key holds at
most 4 of these waits at once, so wait again once one answers rather than opening another beside it.

## Files

Files work as in the web UI ([Attachments](operator-guide.md#attachments)). A key holding
`threads:write` uploads a file to a session and names the upload in a message; one holding
`threads:read` lists and reads a thread's files. An upload is yours, as the key's messages are: it
counts against your own pending uploads, and you can name it in a message from the web UI too.
Continuing the example, with `threads:write`:

```bash
s="$origin/api/operator/v1/s/builder/main"
curl -sS -H @<(auth) -H 'Content-Type: text/plain' --data-binary @build.log \
  "$s/uploads?name=build.log"
curl -sS -H @<(auth) -H 'Content-Type: application/json' \
  -d '{"request_id":"log-1","seen_through":4,"attachments":[{"upload":"<upload>"}]}' \
  "$s/threads/12/messages"
curl -sS -H @<(auth) "$s/threads/12/files"
curl -sS -H @<(auth) -o fetched.log "$s/threads/12/messages/5/files/build.log"
curl -sS -H @<(auth) -H 'Range: bytes=-4096' "$s/threads/12/messages/5/files/build.log"
```

In order, these:

1. Upload `build.log`, its bytes as they are, declaring its type in `Content-Type`. The answer holds
   its reference, `upload`. Until a message names it, `POST $s/uploads/<upload>/remove` removes it.
2. Name the upload in a message to thread 12 of `builder/main`, with `seen_through` the latest
   message you have seen there. Once a message carries a file it stays with that message for good,
   and removing it is refused.
3. List the thread's files, each with the message that carries it.
4. Read one by that message and its name there, here message 5, into `fetched.log`.
5. Read only its final 4 KiB, answered `206`. The server answers one range as asked, a range outside
   the file `416`, and any other `Range` with the whole file.
