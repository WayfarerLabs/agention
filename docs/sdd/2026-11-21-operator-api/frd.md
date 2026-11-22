# Operator API: Functional Requirements

- Status: Draft, awaiting the operator's acceptance
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

### Keys

**K1. Keys created in Settings.** Settings has an API keys section. The operator creates a key with
a name and an expiry, and chooses what it may do (K4). The key's secret is shown once, when it is
created, with a way to copy it, and never again by the server.

**K2. Keys expire.** A key's expiry is chosen from 7, 30, 60 or 90 days, or a date of the operator's
choosing up to a year away. No key lives forever.

**K3. Keys are managed in one place.** The section lists every key with its name, what it may do,
when it was created, when it expires and when it was last used. The operator can revoke any key.
Creating or revoking a key needs a recent sign-in, as changing passkeys does. The operator holds at
most 20 keys.

**K4. A key acts as the operator, within its scope.** A key is either **read**, which may read what
the operator reads in the web UI, or **read and write**, which may also do what the operator does
with threads and sessions: write and start threads, answer asks, mark read, unread and archived, and
set groups and tags. No key may manage keys, passkeys or Settings, transcribe, or list, approve,
reject or revoke agents' registrations; those stay behind a passkey.

**K5. Revocation and expiry are immediate.** A revoked or expired key stops working at once. The
server keeps no copy of a key's secret from which the key could be used.

### API

**A1. One API, two credentials.** A client calls the same operations, with the same request and
response shapes and the same rules, as the web UI does for the same things. A behavior is never
implemented twice.

**A2. A stable contract.** The API a key uses is versioned. A client built against a version keeps
working across server releases while the server serves that version, and the server says which
versions it serves.

### Documentation

**D1. Live documentation.** Started with `--api-docs`, the server serves documentation of the API a
key uses under `/docs/api/`: a page a person reads, and the machine-readable description a client
generator reads. Without the flag, nothing is served there.

**D2. Generated from the code.** The documentation is generated from the same definitions the server
runs, so it cannot describe a request, field, bound or error the server does not have.

### Engineering

**E1. Agents and the web UI unchanged.** No agent route, tool or answer changes, and the agent API
version stays as it is. The web UI keeps every behavior it has.

**E2. Collateral.** The operator guide, SECURITY.md, the architecture document and ADRs describe
keys, the API and its documentation, including the decision that integrations may now act for the
operator, which ADR 0001 ruled out.

## Out of scope

- Keys for anyone but the operator, and sharing the operator's account with other people.
- OAuth, and any sign-in flow for a client other than pasting a key.
- Push to clients, and a long poll for the operator: webhooks, server-sent events and notifications
  (agention#30). A client polls, as the web UI does.
- Keys limited to some sessions or agents.
- A pitwall integration itself, which belongs to pitwall.

## Operator rulings, 2026-11-21 onward

None yet.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- A key created in Settings reads the operator's sessions and threads with `curl`, following only
  the served documentation.
