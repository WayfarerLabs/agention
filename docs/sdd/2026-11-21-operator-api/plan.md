# Operator API: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md)
- Branch: `build/operator-api`
- Vehicle: one pull request carrying the SDD and the build, at the operator's direction ("the PR");
  each box is checked when it is built, reviewed and green.

## Delivery 1: keys, the operator mount and its documentation

- [x] The operations table, with the web mount and the agent mount's thread routes built from it and
      no behavior changed; response schemas for every operation (A1, E1) (agention#41).
- [x] Migration 5 and the key store: create, list, revoke, expiry, the 20-key bound, hashing, last
      used (K1 to K3, K5) (agention#41).
- [x] The key identity and grants, the read-only rule, and `checkCredential` for keys (K4, K5)
      (agention#41).
- [x] The operator mount: bearer only, no cookies, its version in the path, rates and refusals (A2)
      (agention#41).
- [x] The operator's wait across sessions: the cross-session cursor, the notifier's all-sessions
      channel, revocation ending a key's wait, and the loop shared with the agent wait (A3)
      (agention#41).
- [x] The key management routes on the web mount, with recent sign-in (K3) (agention#41).
- [x] The OpenAPI document, `--api-docs` and `/docs/api/`, and the committed `docs/api/openapi.json`
      with its parity test (D1, D2) (agention#41).
- [x] Settings sections: the declared list, `/settings/<slug>`, the navigation column on wide
      screens and the list-then-section flow on phones, the recent sign-in offer per section, and
      the existing sections moved into it with no behavior lost (S1) (agention#41).
- [x] Settings: the API keys section (K1 to K3) (agention#41).
- [x] Permanent docs: ADR 0003, ADR 0001's clause marked superseded, the architecture document, the
      operator guide (keys, the operator API, `--api-docs`), SECURITY.md,
      `docs/review-checklist.md`, `docs/live-testing.md`, README and `docs/development-context.md`
      (E2) (agention#41).
- [x] Live run: a key created in Settings reads sessions and threads with `curl` from the served
      docs; a read key is refused a write; a revoked key is refused; the web UI and an agent bridge
      unchanged (agention#41; on a loopback bed at the reviewed head, with an agent bridge approved
      and answered through keys).
- [x] `locked.md` in this directory, with the final merge (agention#41).

## Delivery 2: files, after attachments (agention#46)

- [x] Main merged in, with attachments' four file routes declared as operations on every mount,
      bytes bodies and answers in the declaration and the API document, file scopes confirmed in
      every store call, and the credential on every chunk (K4, rulings 10 and 11) (agention#41).
- [x] Live run: a key uploads, attaches, lists and reads a file, whole and by range; a read key is
      refused an upload; removing an attached file is refused (agention#41; on a loopback bed at
      64d2f14, with revocation mid-transfer and the bridge's fetch too).
- [x] `locked.md` updated for files (agention#41).
