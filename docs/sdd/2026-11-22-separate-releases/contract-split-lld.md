# Separate releases: the server-only contract LLD

- Status: Draft
- Date: 2026-11-22
- Requirements: [FRD](frd.md) R2 and ruling 2; [HLA](hla.md) "What each line ships" and "The
  server-only contract"; [plan](plan.md) delivery 1
- Code cited at f7b0cfd, the delivery's base

This settles what the HLA leaves to delivery 1: the new package, the rule for what stays in
`packages/api`, and where the line falls in the files that hold both sides. It is a refactor: no
route, schema, wire format or generated document changes.

## Why it is needed

The bridge's bundle carries every module of `packages/api`. The bridge imports the package through
its index (for example `apps/bridge/src/tools.ts:28`, `apps/bridge/src/session.ts:8`), the index
re-exports every module (`packages/api/src/index.ts:1-20`), and a module's top-level zod calls are
not side-effect free to esbuild, so none is dropped. A metafile of the bridge's build at the base
lists `api-keys.ts`, `attention.ts`, `passkeys.ts`, `settings.ts`, `scopes.ts`, `routes.ts` and
`groups-and-tags.ts` among its inputs, with their bytes in the output, though the bridge imports
nothing from any of them.

## The package

`packages/server-api`, named `@wayfarerlabs/agention-server-api`, private, with `exports` pointing
at its source like `packages/api`. The name follows the other workspace packages
(`@wayfarerlabs/agention-api`, `-build`, `-private-files`) and says what it is: the server's own
part of the API contract. "operator-api" was rejected because the operator API is one mount
(`/api/operator`), while the package also serves the web mount and holds server internals such as
the routes' path parameters and the scopes. Its path is outside `packages/api`, so the agent line's
release configuration can exclude it as a path of its own.

It depends on `@wayfarerlabs/agention-api` and zod; `packages/api` never imports it. Its entry
points are `.`, `./json-schemas` and `./registration-code`, the last two kept separate as today so
the web bundle carries neither (`node:crypto`, and the JSON Schema only the server reads).

## The rule

The unit is the module. **A module stays in `packages/api` when the bridge's bundle includes it**:
the bridge's sources import it, or a module that stays imports it. Everything else is in
`packages/server-api`. Measured from the bridge's non-test imports at the base, the bridge imports
`agent-api`, `bounds`, `errors`, `files`, `names`, `origin`, `registrations`, `sessions`, `text`,
`thread-lists` and `threads`, which bring in `references` and `time`, and, through `sessions.ts:3`
and `thread-lists.ts:12`, `groups-and-tags`.

Where a module the bridge includes holds the operator's side of its subject beside the agent's, the
operator's side moves to a module of the same name in `packages/server-api`. That is what frees
`groups-and-tags.ts`: the bridge reaches it only through the operator's views in `sessions.ts` and
`thread-lists.ts`, and no agent route reads or writes groups or tags (`groups-and-tags.ts:6-7`).

A symbol-level rule ("only the exports the bridge imports") was rejected: it would move the agent
API's own answers, such as `threadSummary` and `writeResult`, which the bridge passes through
without importing, scatter each subject across both packages, and move a schema between packages
whenever the bridge starts reading one.

## Moved whole

`api-keys.ts`, `attention.ts`, `groups-and-tags.ts`, `json-schemas.ts`, `passkeys.ts`,
`registration-code.ts`, `routes.ts`, `scopes.ts` and `settings.ts`, with their tests.

- `scopes.ts` and `routes.ts` serve the agent mount too (`apps/server/src/http/agent-operations.ts`
  names scopes and `sessionParams`), but only the server reads them: the bridge builds its paths
  itself and holds no scope.
- `registration-code.ts` is imported by the server's store and by tests only; the bridge relays the
  code the server answers with (`apps/bridge/src/session.ts:222`). Its comment, which said the
  bridge computes it too, is corrected.

## Split

| Module             | Stays in `packages/api`                                                                                                                                                     | Moves to `packages/server-api`                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions.ts`      | presence, state, outcome, a thread's presence, the status update and the status (`:1-126`)                                                                                  | a session's log and its read mark, and the sessions view (`:128-204`); with `threadStartInput` from `threads.ts:286-299`                                       |
| `thread-lists.ts`  | the filters a session's list takes, its query, the wait's seconds, query and result, the page (`:37-48`, `:53-63`, `:87-97`, `:255-271`, `:415-417`); `searchText` exported | the operator's list: its filters, orders, groups, counts, roll-ups, the operator's wait and bulk marks (`:49-52`, `:64-85`, `:99-253`, `:273-413`, `:419-471`) |
| `registrations.ts` | the public key, the token's claims, the code pattern, the status, submit and state (`:1-44`)                                                                                | the registration id, the registrations list and approval (`:46-109`)                                                                                           |

`threadStartInput` joins the operator's sessions module, where the architecture already lists it
("the operator's start of a thread on a session"). Tests split with their subjects.

What stays in `packages/api` but only the server reads is either a building block shared with the
bridge's part (`bounds.ts` query readers, `names.ts` path patterns) or a fact of the agent's own
contract the bridge does not happen to import (the token's claims, the error statuses, the pending
upload limits). A change to one releases both lines, the safe failure.

## The boundary test

`apps/bridge/src/bundle.test.ts` builds the bridge from `src/main.ts` through a new
`bundleInputs(entry)` in `packages/build`, which shares `bundle`'s esbuild options
(`packages/build/src/bundle.ts:37-45`), writes nothing, and returns the metafile's inputs as
absolute paths. It resolves both contract packages by name through Node's resolution, to their real
directories, and asserts that some input is in `packages/api` (so the paths compare) and none is in
`packages/server-api`. Nothing else holds the line: npm links every workspace into the root
`node_modules`, and the bridge devDepends on the server (`apps/bridge/package.json:33`), which
depends on `packages/server-api`. The bridge now declares `packages/server-api` among its
`devDependencies` too, since its tests derive registration codes.

## Verification

- `docs/api/openapi.json` regenerated by `scripts/generate-api-docs.sh`, byte-identical.
- `scripts/generate-plugins.sh --check` passes.
- The test fails when the bridge imports a moved module, and passes once the import is gone.
- An added zod call in each module of `packages/server-api` leaves the bridge's bundle
  byte-identical; the same edit in `packages/api/src/names.ts` changes it.
