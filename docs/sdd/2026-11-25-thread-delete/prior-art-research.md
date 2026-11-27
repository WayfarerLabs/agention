# Prior-art research: deleting threads

Research date: 2026-11-25. Scope: how mail, chat and issue trackers delete for good and what they
keep, what a client gets for a deleted item, confirmation for destructive bulk actions, deleting
securely in SQLite, and backups. Each finding ends with what it means for Agention
(**Implication**). Source IDs such as [S1] refer to the sources table at the end; [M1] is a
measurement made for this design.

## Executive summary

- Permanent deletion that keeps a bare identity is the common pattern: Slack and Discord delete
  events carry only ids [S17], [S24]; Matrix keeps a redacted event's skeleton [S27], [S28]; Synapse
  can purge a room entirely [S29]. Agention's tombstone (identity plus a deleted marker) sits with
  them.
- GitHub answers **410 Gone** for a deleted issue to a caller who may read the repository, and 404
  to one who may not [S14]; RFC 9110 prefers 410 when removal is known to be permanent [S1]. That is
  exactly Agention's shape: `not_found` for the unauthorized, `deleted` for the rest.
- Confirmation guidance converges: name the outcome on the button, give context, focus Cancel, and
  reserve typed confirmation for the rarest, gravest actions [S38], [S39]. GitHub's issue delete is
  a second click [S13]; its repository delete needs typing [S15].
- In SQLite, deleting rows is not erasing them: free pages, FTS5 index segments and the log keep the
  bytes unless `secure_delete`, FTS5's own secure delete and a truncating checkpoint are all used,
  and content written before they were enabled needs one full rewrite [S2], [S4], [S9], [S43], [M1].
  Forensic tools recover deleted records routinely [S10], [S11].
- Backups keep deleted data until they expire; regulators and vendors treat that as acceptable when
  it is said plainly and the copies are beyond use [S40], [S41].

## 1. Deletion and what remains

- **Slack.** Message deletion "is permanent" [S21]; the `message_deleted` event keeps only channel,
  `ts` and `deleted_ts` [S17]. Deleting a channel is for owners and admins, removes its history, and
  needs a "Yes, permanently delete the channel" checkbox; archiving is the reversible alternative
  [S19]. `channel_deleted` carries only the id [S18]. API errors do not distinguish deleted from
  invalid: `channel_not_found`, `message_not_found` [S16]. **Implication:** deleting a whole
  conversation is an administrator's act behind an explicit confirmation, beside a reversible
  archive, which matches Agention's archive and the operator-only delete (FRD R8).
- **Discord.** Deleting another's message needs `MANAGE_MESSAGES`; bulk delete takes 2 to 100
  messages [S25]. MESSAGE_DELETE carries only ids [S24]. A deleted channel answers 404 with code
  10003 Unknown Channel [S23]. **Implication:** a bulk bound of 100 has precedent, and matches
  Agention's bulk marks.
- **Matrix.** Redaction strips every key "not required by the protocol" and cannot be undone, so
  server owners can remove the content from their databases [S27]; room version 11 lists what
  survives: ids, type, sender, timestamps and graph links [S28]. Synapse's room delete with `purge`
  "will remove all trace of the old room" from the database [S29]; purging history keeps the room's
  state and last event [S30]. **Implication:** a tombstone holding identity and structure, never
  content, is the established form (HLA "The tombstone"). Synapse's note that Postgres needs
  `VACUUM FULL` to return space is the same problem as SQLite's free pages (section 4).
- **GitHub issues.** Only owners or admins delete, after an organization enables it; the
  confirmation is a second "Delete this issue" click; collaborators are not notified [S13]. The REST
  API answers 410 for a deleted issue to a caller with read access, 404 without it [S14].
  **Implication:** the `deleted` code and 410 (HLA "The agent's view"), sent only after
  authorization so isolation (A3) holds.
- **Gmail.** Deleting moves mail to Trash for 30 days; "Delete forever" ends it sooner. Bulk
  selection is the page first, then "Select all N conversations" [S31]. The API's `messages.delete`
  is immediate and permanent, needs the broadest scope, and the docs steer clients to `trash`
  instead [S32], [S33]. **Implication:** permanent deletion through an API deserves a scope of its
  own (HLA `threads:delete`). A trash was set aside because it would keep the secret that prompts
  most deletes.

## 2. Answering for a deleted resource

- RFC 9110: 410 says the resource is no longer available and the condition is likely permanent; a
  server that cannot tell should use 404 [S1].
- Google AIP-164: a soft-deleted resource stays readable and hidden from lists; expunging needs a
  permission of its own; permission is checked before existence [S34]. AIP-135: deleting a missing
  resource is NOT_FOUND unless `allow_missing` [S35].
- Zalando: after DELETE, a GET returns 404 or 410, with 410 when the deletion is traceable [S37].
  Microsoft's Azure guidelines answer 204 to a DELETE whether or not the resource exists [S36].
- **Implication:** Agention knows the deletion is permanent and keeps a trace, so 410 fits; deleting
  an already deleted thread succeeds (idempotent, as Azure's rule), and authorization comes before
  the deleted check, as AIP-164 orders it.

## 3. Confirming a destructive bulk action

- NN/g: confirm only serious, irreversible actions, since overuse breeds habituation; restate what
  will happen; label buttons with the outcome, not Yes or No; require a nonstandard action such as
  typing only for the rarest and most dangerous [S38].
- GitHub's Primer: a danger button with clear context, a title that is a specific question ("Delete
  repository?"), a button naming the verb, and focus on Cancel for danger dialogs [S39]. Its
  repository deletion asks for the name typed [S15]; its issue deletion does not [S13].
- Gmail's bulk confirmation is described only by third parties [S42].
- **Implication:** the warning names the count in its title and button, says what is lost and what
  is not reached, and focuses Cancel; typing is not required (FRD Q5, HLA "The web UI"). Agention's
  shared `Confirmation` focuses its confirming button today, so it changes once, for every
  irreversible action.

## 4. Deleting securely in SQLite

- `secure_delete = ON` overwrites deleted content with zeros; `FAST` does so only where it costs no
  extra I/O and leaves traces on freelist pages; it does not reliably scrub FTS shadow tables [S2].
- FTS5 has a `secure-delete` option of its own, from SQLite 3.42: without it, a delete adds
  delete-keys and "the old full-text index entries remain in the database file" until merged; with
  it they are removed. The same page says the core `secure_delete` pragma is needed beside it, and
  that once used, versions before 3.42 can no longer read the table [S43]. The schema's
  `contentless_unindexed` came in 3.47 [S44], so every SQLite that opens Agention's database has the
  option.
- A contentless FTS5 table deletes a row only by the `delete` command, given its rowid and the
  values it was written with; other values give unpredictable results [S43].
- `incremental_vacuum(N)` frees up to N pages and truncates the file, only in incremental mode [S2]:
  it returns space, and erases nothing. `VACUUM` removes all traces of deleted content but rewrites
  the file and needs up to twice its size free [S3].
- A checkpoint normally rewinds the log rather than truncating it, and long readers keep it from
  completing; `wal_checkpoint(TRUNCATE)` truncates it [S4], [S2]. A third party showed a deleted
  string surviving in the log after an ordinary checkpoint, even with `secure_delete` on [S9].
- Forensic work carves deleted records from freelists, free blocks, unallocated space and the log
  [S10], [S11], and NIST has test cases for such tools [S12].
- Triggers: a `WHEN` clause decides whether a trigger's body runs, and `RAISE(ABORT)` fails the
  statement [S5]; SQLite's own table-rebuild procedure drops and creates triggers inside a
  transaction [S7]. No source names a guard keyed on another table's state as a known pattern.
- **[M1] Measurement.** On Node 24.18 (SQLite 3.53.1), a database in WAL mode held 50 threads with
  search indexes shaped as Agention's and a 1 MiB file. One thread's text, title and file were
  deleted, then a `TRUNCATE` checkpoint ran, and the files searched for each. Only with
  `secure_delete`, FTS5 `secure-delete` and the truncating checkpoint together was none of them
  found; dropping either option left some behind. Caveats: one run; tables without Agention's
  triggers; and both options were on before the data was written. A review's run that seeded the
  data first found older text surviving in the unused space of an index's interior page, which
  neither option reaches.
- **Implication:** all three measures, plus one full rewrite when secure deletion is first enabled
  (HLA "Erasure"). The tombstone-gated guard is this design's own choice, resting on `WHEN`
  semantics, not on precedent.

## 5. Backups

- The UK ICO: erase from backups too, and where data stays in a backup until overwritten, put it
  beyond use and be clear with people about it [S40]. Google Cloud lets backups expire on schedule,
  about six months after a delete, rather than editing them [S41].
- **Implication:** the operator guide says backups keep a deleted thread until replaced, and how to
  replace them (FRD R14). Agention does not edit backups.

## Refuted / do-not-rely-on

- "GitHub answers 404 for a deleted issue": refuted for callers with read access, who get 410 [S14].
  No live call was made.
- "GitHub never reuses a deleted issue's number": no primary source found. Agention's rule rests on
  its own numbering, not on this.
- "`secure_delete` scrubs the log": SQLite's docs are silent; the evidence says it does not [S9],
  [M1] without a truncating checkpoint.
- "`secure_delete` scrubs full-text indexes": refuted by [S2], [S43] and [M1]; FTS5 needs its own
  option.
- "Secure deletion reaches content written before it was enabled": refuted by the review's run in
  [M1]; a full rewrite is needed once.
- "An incremental vacuum erases": it frees and truncates pages, nothing more [S2].
- "DROP TRIGGER is transactional": implied by [S7], never stated outright. The design does not rely
  on it.
- Slack's `message_deleted` carrying the previous message, and a distinct Slack error for a deleted
  channel, are not documented [S16], [S17].
- Apple's and Material's guidance on destructive buttons could not be read (pages need scripts), so
  it is not cited.

## Open questions

None remain for research. Whether every SQLite Agention runs on has FTS5 `secure-delete` is settled
by the schema's own use of `contentless_unindexed` [S44].

## Sources

| ID  | Source                                                        | Grade                     |
| --- | ------------------------------------------------------------- | ------------------------- |
| S1  | RFC 9110, sections 15.5.5 and 15.5.11                         | Spec                      |
| S2  | sqlite.org: PRAGMA statements                                 | Official docs             |
| S3  | sqlite.org: VACUUM                                            | Official docs             |
| S4  | sqlite.org: Write-ahead logging                               | Official docs             |
| S5  | sqlite.org: CREATE TRIGGER                                    | Official docs             |
| S6  | sqlite.org: ON CONFLICT                                       | Official docs             |
| S7  | sqlite.org: ALTER TABLE                                       | Official docs             |
| S8  | sqlite.org: DELETE                                            | Official docs             |
| S9  | antonz.org: Secure delete in SQLite (2024)                    | Third party               |
| S10 | Pawlaszczyk, Mobile Forensics, chapter 5 (search only)        | Research paper            |
| S11 | Pawlaszczyk and Hummert, Making the Invisible Visible (2022)  | Research paper            |
| S12 | NIST CFTT: SQLite data recovery test cases (search only)      | Official docs             |
| S13 | docs.github.com: Deleting an issue                            | Official docs             |
| S14 | docs.github.com: REST API, get an issue                       | Official docs             |
| S15 | docs.github.com: Deleting a repository                        | Official docs             |
| S16 | docs.slack.dev: chat.delete                                   | Official docs             |
| S17 | docs.slack.dev: message_deleted event                         | Official docs             |
| S18 | docs.slack.dev: channel_deleted event                         | Official docs             |
| S19 | slack.com help: Delete a channel                              | Official docs             |
| S20 | slack.com help: Message and file retention                    | Official docs             |
| S21 | slack.com help: Edit or delete messages                       | Official docs             |
| S22 | docs.slack.dev: conversations.history                         | Official docs             |
| S23 | docs.discord.com: Opcodes and status codes                    | Official docs             |
| S24 | docs.discord.com: Gateway events                              | Official docs             |
| S25 | docs.discord.com: Message resource                            | Official docs             |
| S26 | docs.discord.com: Channel resource                            | Official docs             |
| S27 | spec.matrix.org: Client-server API, redactions                | Spec                      |
| S28 | spec.matrix.org: Room version 11                              | Spec                      |
| S29 | Synapse: Rooms admin API                                      | Official docs             |
| S30 | Synapse: Purge history API                                    | Official docs             |
| S31 | support.google.com: Delete or recover Gmail messages          | Official docs             |
| S32 | developers.google.com: Gmail API messages.delete              | Official docs             |
| S33 | developers.google.com: Gmail API messages.trash               | Official docs             |
| S34 | google.aip.dev/164: Soft delete                               | Official docs             |
| S35 | google.aip.dev/135: Delete                                    | Official docs             |
| S36 | github.com/microsoft/api-guidelines: Azure guidelines         | Official docs             |
| S37 | Zalando RESTful API guidelines: HTTP requests                 | Official docs             |
| S38 | nngroup.com: Confirmation dialogs                             | Third party (UX research) |
| S39 | primer.style: ConfirmationDialog guidelines                   | Official docs             |
| S40 | ico.org.uk: Right to erasure                                  | Official docs (regulator) |
| S41 | docs.cloud.google.com: Data deletion on Google Cloud          | Vendor docs               |
| S42 | hongkiat.com: Bulk delete Gmail conversations (search only)   | Third party               |
| S43 | sqlite.org: FTS5 (secure-delete, contentless tables, delete)  | Official docs             |
| S44 | sqlite.org: Release history (3.42.0, 3.47.0)                  | Official docs             |
| M1  | Measurement for this design, 2026-11-25 (method in section 4) | Local experiment          |

S6, S8, S20, S22 and S26 were read and support details only. S10, S11, S12 and S42 were seen through
search results, not read in full.
