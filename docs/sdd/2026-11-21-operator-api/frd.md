# Operator API: Functional Requirements

- Status: Accepted by the operator 2026-11-21 with changes (ruling 5); A3 added by ruling 7
- Date: 2026-11-21
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim or as close transcription.
- Origin: agention#17, and the operator's direction of 2026-11-21: API keys created in Settings,
  much like GitHub's personal access tokens, which a client uses to call the API as the operator; an
  API fit for such clients, either by making the current one general purpose in a way the web UI can
  still use, or by keeping the web UI's API and adding a general-purpose one beside it; and live API
  documentation, generated from the code, that the server serves under `docs/api/` when started with
  a flag. The first such client is pitwall, a terminal multiplexer for coding agents whose author
  would like to show Agention's data in it.

## Why this exists

The operator watches their agents in more than one place. A tool that already shows those agents,
such as pitwall, could show which of them need the operator, and in time let the operator answer
them, if it could read Agention. Today only the web UI, signed in with a passkey, and approved
agents, each reaching only its own session, can call the server, so there is no credential such a
tool can hold and no API documented for it to build against.

## Who this is for

- **The operator**, who creates, names and revokes keys, and decides what each may do.
- **A client acting for the operator**, such as pitwall: a program the operator runs that holds a
  key and calls the API.
- **Agents** are unaffected.

## Functional requirements

### Settings

**S1. Settings with structure.** Settings is organized as named sections, each on its own page with
its own address, reached from a navigation that lists them grouped by kind, as GitHub's settings
are: on a wide screen the navigation stays beside the open section, and on a phone Settings opens on
the list and a section offers the way back to it. Passkeys, voice, signing out and API keys are
sections, and adding a later section adds an entry without reshaping the rest (ruling 4). The
addresses Settings has today keep leading where they lead.

### Keys

**K1. Keys created in Settings.** Settings has an API keys section (S1). The operator creates a key
with a name and an expiry, and chooses its scopes (K4). The key's secret is shown once, when it is
created, with a way to copy it, and never again by the server.

**K2. Expiry.** A key's expiry is chosen from 7, 30, 60 or 90 days, a date of the operator's
choosing up to a year away, or no expiry, which Settings warns against when it is chosen (ruling 2).

**K3. Keys are managed in one place.** The section lists every key with its name, its scopes, when
it was created, when it expires and when it was last used. The operator can revoke any key. Creating
or revoking a key needs a recent sign-in, as changing passkeys does. The operator holds at most 20
keys.

**K4. A key acts as the operator, within its scopes.** A key holds one or more scopes, each a
resource and an access (ruling 1):

- **`threads:read`**: the operator's thread list and its counts, and any thread with its messages.
- **`threads:write`**: also starting threads, writing in them and answering asks, and marking
  threads read, unread and archived, one at a time or in bulk.
- **`sessions:read`**: the sessions view with its agents, tags and groups, a session's log, the
  count of sessions with unread updates, and agents' registrations.
- **`sessions:write`**: also marking a session's log read, managing groups and tags and setting a
  session's group and an agent's or a session's tags.
- **`sessions:approve`**: also approving, rejecting and revoking agents' registrations (ruling 5).

A write or approve scope includes its resource's read, and neither includes the other. Scopes are
named `<resource>:<access>` so that later resources add scopes without changing these. No key may
manage keys, passkeys or Settings, or transcribe; those stay behind a passkey.

**K5. Revocation and expiry are immediate.** A revoked or expired key stops working at once. The
server keeps no copy of a key's secret from which the key could be used.

### API

**A1. One API, two credentials.** A client calls the same operations, with the same request and
response shapes and the same rules, as the web UI does for the same things. A behavior is never
implemented twice.

**A2. A stable contract.** The API a key uses is versioned. A client built against a version keeps
working across server releases while the server serves that version, and the server says which
versions it serves.

**A3. A client waits for what is new.** A client can ask to be answered as soon as something new
reaches the operator in any session, such as a message or an ask from an agent, instead of polling
rapidly, and be told only of what it has not been told before (ruling 7). Revoking or expiring the
key ends a wait it holds.

### Documentation

**D1. Live documentation.** Started with `--api-docs`, the server serves documentation under
`/docs/api/` of the API a key uses and of the agent API the bridge uses (ruling 2): a page a person
reads, and the machine-readable description a client generator reads. Without the flag, nothing is
served there.

**D2. Generated from the code.** The documentation is generated from the same definitions the server
runs, so it cannot describe a request, field, bound or error the server does not have. The
machine-readable description is also kept in the repository, and checks fail when it differs from
what the code generates, so every change to the contract is reviewed as a change to that file
(ruling 2).

### Engineering

**E1. Agents and the web UI unchanged.** No agent route, tool or answer changes, and the agent API
version stays as it is. The web UI keeps every behavior it has.

**E2. Collateral.** The operator guide, SECURITY.md, the architecture document and ADRs describe
keys, the API and its documentation, including the decision that integrations may now act for the
operator, which ADR 0001 ruled out.

## Out of scope

- Keys for anyone but the operator, and sharing the operator's account with other people.
- OAuth, and any sign-in flow for a client other than pasting a key.
- Push to clients: webhooks, server-sent events and notifications (agention#30). A3 is met by
  waiting on a request, as agents already do.
- Recording which key wrote a message, which an audit log (agention#42) will capture (ruling 6).
- Keys limited to some sessions or agents.
- A pitwall integration itself, which belongs to pitwall.

## Operator rulings, 2026-11-21 onward

1. (2026-11-21) Asked how the API should be shaped, the operator chose "Third mount, shared
   handlers": a versioned, key-only mount beside the web UI's, serving the same operations with the
   same code. Asked what a key may do: "Yeah, let's define threads read/write and sessions
   read/write for now. Leave room for other scopes." Asked whether keys may approve or revoke agent
   registrations: "Only with session/write". Taken: K4's four scopes, named so others can follow,
   with registrations under the sessions scopes (amended by ruling 5).
2. (2026-11-21) Asked about expiry, the operator chose "Same, plus no expiry"; about the
   documentation's scope, "Operator and agent mounts"; and whether to commit the generated
   description with a drift check, "Yes". Taken: K2's no-expiry choice, D1's two APIs, and D2's
   committed description.
3. (2026-11-21) Asked whether to close out the voice-and-settings SDD first: "Leave it". Taken: this
   effort does not touch that SDD.
4. (2026-11-21) "Btw, in doing this, we're going to need to add more structure to settings. It's
   important that it still work on mobile, but think more Github settings vs what we have today.
   What you do here will establish the pattern for future settings expansion." Taken: S1.
5. (2026-11-21) Asked to accept the revised requirements, the operator chose "Accept with changes":
   "Only two changes: 1. Move passkeys to /settings/passkeys 2. Lets add a special sessions:approve
   scope specifically for approving/managing registrations. sessions:write is just groups/tags/etc."
   Taken: Passkeys is the Settings section at `/settings/passkeys`, and `/passkeys` redirects there
   (S1); K4 gains `sessions:approve`, which alone covers approving, rejecting and revoking
   registrations.
6. (2026-11-21) Asked whether to mark messages written with a key by the key's name, the operator
   chose "Not now, file it": "So my thinking is taht we eventually offer an audit log feature, which
   is where this would be captured. Future work, though. Please create a placeholder github issue
   for it." Taken: agention#42; a message written with a key is the operator's, with no new field.
7. (2026-11-21) Asked whether to file a change feed as a follow-up: "I mean, what would it take to
   do this write? SSE?" Offered a long poll as a follow-up, a long poll in this effort, or
   server-sent events, the operator chose "Long poll, in this PR". Taken: A3.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- A key created in Settings reads the operator's sessions and threads with `curl`, following only
  the served documentation.
