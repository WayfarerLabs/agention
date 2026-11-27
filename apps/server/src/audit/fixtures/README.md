# OCSF 1.9.0 fixtures

The audit log's tests validate every event against the Open Cybersecurity Schema Framework's class
schemas for the version events carry, 1.9.0. These files are kept exactly as fetched, so Prettier
leaves them alone.

`api_activity.json`, `authentication.json` and `entity_management.json` are schema.ocsf.io's JSON
Schema export of API Activity (6003), Authentication (3002) and Entity Management (3004), each
fetched on 2026-11-26 from `https://schema.ocsf.io/schema/1.9.0/classes/<class>?profiles=`. The
empty `profiles` applies no profile: without it, the export applies every one, which makes
attributes such as `cloud` required. The export is built from the official `ocsf/ocsf-schema`
repository at tag `1.9.0` (commit 856d462bd20dc46cc1ffed2dfffe3b91ef0fbeba), whose dictionary also
defines what the export does not check (`type_uid` as `class_uid * 100 + activity_id`, and the
`ip_t` and `uuid_t` patterns), so the tests check those beside the schema.

They are the OCSF project's work, under the Apache License 2.0 in `LICENSE`. Moving to another OCSF
version replaces each schema with that version's, fetched the same way, and changes the version the
builder writes.
