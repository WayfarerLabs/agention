# Operator API: Locked

- Locked: 2026-11-22
- Shipped in: agention#41, which closes agention#17

## What shipped

- API keys, created in Settings with a name, an expiry (7, 30, 60 or 90 days, a date up to a year
  away, or none) and scopes, shown once, listed with when each was last used, and revoked there.
  Creating and revoking need a recent sign-in, at most 20 keys are live, and replacing the
  operator's passkeys with `agention passkey-link` revokes every live key (ruling 8).
- Scopes `threads:read`, `threads:write`, `sessions:read`, `sessions:write` and `sessions:approve`,
  held by every identity: a browser session holds all of them, a key its own, and an agent's
  registration `threads:write` over its own session. The mount and the store both check them.
- The operator API at `/api/operator/v1/`, bearer keys only, serving the web UI's operations from
  one declaration each, with a long poll across every session (ruling 7, confirmed by ruling 9).
- An OpenAPI 3.1 document of the operator and agent APIs, generated from those declarations,
  committed at `docs/api/openapi.json` with a parity test, and served with a static page under
  `/docs/api/` by `agention serve --api-docs`.
- Settings in sections at `/settings/<slug>`, declared in one list, with a navigation column on wide
  screens and a list-then-section flow on phones; Passkeys moved to `/settings/passkeys` (ruling 5).
- ADR 0003, which supersedes ADR 0001's clause that no integration acts for the operator.

The live run passed on a loopback bed at the reviewed head: a key created in Settings read sessions
and threads with `curl` from the served docs, a read key was refused a write, a revoked key was
refused and its wait ended, and the web UI and an agent bridge, approved and answered through keys,
worked unchanged.

## Where it lives now

The permanent record is in `docs/adrs/0003-operator-api-keys.md`, `docs/architecture.md`,
`docs/operator-guide.md`, `SECURITY.md`, `docs/review-checklist.md`, `docs/live-testing.md`,
`docs/api/openapi.json`, `docs/development-context.md`, `CONTRIBUTING.md` and the README. Nothing
here is needed to understand or work on the system.

## What follows

An audit log recording which key wrote what (agention#42), and a bound on concurrent waits per key
(agention#45), are their own efforts. Push to clients, such as notifications (agention#30), is not
planned here.
