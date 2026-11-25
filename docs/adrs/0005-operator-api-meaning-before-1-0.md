# 5. The operator API's meaning may change in place before 1.0

Date: 2026-11-25

## Status

Accepted. Supersedes in part, until 1.0, "The version is in the path" in
[ADR 0003](0003-operator-api-keys.md): a version still changes only additively in its shape, but
what a field or value means may change in place.

## Context

ADR 0003 holds the operator API to additive change within a version, so a client written against
version 1 keeps working while the server serves it. Before 1.0, some decisions change what an
existing field or value means without changing its shape, such as which messages a thread's file
totals count. Holding each such change to a new version would put a second version beside the first
for every one, while the only clients are the operator's own programs.

## Decision

- Until 1.0, a change in what an existing field or value means may land in place on the operator
  API's current version, by a maintainer's decision.
- Each such change is marked breaking, with a `BREAKING CHANGE:` footer, so the changelog calls it
  out.
- A change of shape that would break a client is still a new version beside the old, as ADR 0003
  says.
- From 1.0, ADR 0003 holds in full.

## Consequences

- A client of the operator API reads the changelog before upgrading the server until 1.0.
- Review looks for a change in meaning that lands without the decision or the footer.
- The agent API is unaffected: every change to its contract, a change in meaning included, bumps its
  version, since agents run whatever bridge their plugin pins.
