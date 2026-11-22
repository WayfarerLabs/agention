# 3. Operator API keys, and integrations that act for the operator

Date: 2026-11-21

## Status

Accepted. Supersedes, in [ADR 0001](0001-agention-v1-architecture.md) "Not doing", the clause of
"One person, who never asks" that allows "no way to ... let people or integrations act for them":
integrations may now act for the operator, within the scopes of a key the operator creates. The rest
of that line stands: there is one operator, nobody shares their account, and the operator makes no
asks.

## Context

The operator watches their agents in more than one place. A tool that already shows those agents,
such as a terminal multiplexer for coding agents, could show which of them need the operator, and in
time let the operator answer them there, if it could read Agention. Until now only the web UI,
signed in with a passkey, and approved agents, each reaching only its own session, could call the
server. A passkey cannot be held by a program, and an agent's registration reaches one session, so
no credential fit such a tool, and no API was documented for it to build against.

The web UI's API was already a JSON API whose every request and response is a schema in
`packages/api`, so the operations a tool needs existed; what was missing was a credential, a stable
contract, and documentation.

## Decision

- **API keys, created in Settings.** The operator creates a key with a name, an expiry (7, 30, 60 or
  90 days, a date up to a year away, or none, which Settings warns against) and one or more scopes.
  Its secret, `agention_` and 256 random bits in base64url, is shown once; the server keeps only its
  SHA-256. Creating or revoking a key needs the recent sign-in that passkey changes need. At most 20
  keys are live at once.
- **Scopes, `<resource>:<access>`.** `threads:read`, `threads:write`, `sessions:read` and
  `sessions:write`, a write including its resource's read. Registrations belong to sessions:
  approving, rejecting or revoking an agent needs `sessions:write`. No key may manage keys, passkeys
  or Settings, or transcribe. Later resources add scopes of the same form.
- **A third mount, the same operations.** `/api/operator/v1/` accepts only a bearer key and refuses
  cookies. It serves the operator operations the web UI uses, declared once with their schemas,
  scope and handler, so the web mount and the operator mount run the same code. The web mount keeps
  its cookie credential, its CSRF and `Origin` checks, its refusal of `Authorization`, and the
  routes no key may call.
- **Every identity has scopes.** A browser session holds every scope, a key its own, and an agent's
  registration `threads:write` over its own session, which is what an agent could already do. One
  scope check before the handler governs every mount, and replaces the separate administration
  grant.
- **The version is in the path.** A version changes only additively; a change that would break a
  client is a new version beside the old. `GET /api/operator` lists the versions served.
- **Documentation generated from the declarations.** The operator and agent operations produce one
  OpenAPI 3.1 document with zod's own JSON Schema output. `agention serve --api-docs` serves it and
  a static page rendered from it under `/docs/api/`; without the flag nothing is served there. The
  document is committed in the repository, and a check fails when the code's document differs from
  it, so every contract change is reviewed as a diff.

## Consequences

- A key is a bearer credential with the operator's reach within its scopes. Whoever holds it acts as
  the operator until it expires or is revoked, so a leaked `sessions:write` key can approve an
  agent. Keys cannot make more keys, add passkeys, or change Settings, so a leaked key cannot
  outlive its revocation.
- A copy of the database holds no usable key, as it holds no usable browser session.
- The operator API is a stable contract the web UI shares: a change to an operator operation is a
  change to every client's API, which the committed document makes visible in review.
- Agents are unaffected: the agent mount's routes, answers and version are unchanged, and they are
  now documented too.
- Push to clients, keys limited to some sessions, and OAuth remain out; a client polls, as the web
  UI does.
