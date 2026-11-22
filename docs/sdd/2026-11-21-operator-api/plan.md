# Operator API: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md)
- Branch: `build/operator-api`
- Vehicle: one pull request carrying the SDD and the build, at the operator's direction ("the PR");
  each box is checked when it is built, reviewed and green.

## Delivery 1: keys, the operator mount and its documentation

- [ ] The operations table, with the web mount and the agent mount's thread routes built from it and
      no behavior changed; response schemas for every operation (A1, E1).
- [ ] Migration 5 and the key store: create, list, revoke, expiry, the 20-key bound, hashing, last
      used (K1 to K3, K5).
- [ ] The key identity and grants, the read-only rule, and `checkCredential` for keys (K4, K5).
- [ ] The operator mount: bearer only, no cookies, its version header, rates and refusals (A2).
- [ ] The key management routes on the web mount, with recent sign-in (K3).
- [ ] The OpenAPI document, `--api-docs` and `/docs/api/`, and the committed `docs/api/openapi.json`
      with its parity test (D1, D2).
- [ ] Settings sections: the declared list, `/settings/<slug>`, the navigation column on wide
      screens and the list-then-section flow on phones, the recent sign-in offer per section, and
      the existing sections moved into it with no behavior lost (S1).
- [ ] Settings: the API keys section (K1 to K3).
- [ ] Permanent docs: ADR 0003, ADR 0001's clause marked superseded, the architecture document, the
      operator guide (keys, the operator API, `--api-docs`), SECURITY.md,
      `docs/review-checklist.md`, `docs/live-testing.md`, README and `docs/development-context.md`
      (E2).
- [ ] Live run: a key created in Settings reads sessions and threads with `curl` from the served
      docs; a read key is refused a write; a revoked key is refused; the web UI and an agent bridge
      unchanged.
- [ ] `locked.md` in this directory, with the final merge.
