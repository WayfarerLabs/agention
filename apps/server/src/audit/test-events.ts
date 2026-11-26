// The audit log as the tests read it: the events a database holds, and each
// event checked against the pinned OCSF class schemas, and for what those
// cannot check, against the rules OCSF states in its sources.
import { Ajv, type ValidateFunction } from "ajv";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { Database } from "../database/database.ts";

export interface StoredEvent {
  seq: number;
  uid: string;
  time: number;
  class_uid: number;
  action: string;
  outcome: "success" | "failure";
  credential_kind: string;
  credential_id: string | null;
  open_until: number | null;
  event: string;
}

// The newest sequence a database has taken, 0 before its first event.
export function lastSeq(db: Database): number {
  const { seq } = db
    .prepare(
      "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'), 0) AS seq",
    )
    .get() as { seq: number };
  return seq;
}

// eventsAfter reads the events after a sequence, in order.
export function eventsAfter(db: Database, after = 0): StoredEvent[] {
  return db
    .prepare("SELECT * FROM audit_events WHERE seq > ? ORDER BY seq")
    .all(after) as unknown as StoredEvent[];
}

// An event parsed, for reading its fields in a test.
export type OcsfEvent = Record<string, unknown> & {
  class_uid: number;
  activity_id: number;
  type_uid: number;
  metadata: { uid: string; sequence: number; event_code: string };
};

export const parsed = (event: StoredEvent): OcsfEvent => JSON.parse(event.event) as OcsfEvent;

const fixtures = new URL("./fixtures/", import.meta.url);

let validators: Record<number, ValidateFunction> | undefined;

// The class schemas, compiled once for a test file's process.
function schemas(): Record<number, ValidateFunction> {
  if (validators === undefined) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const compile = (name: string) =>
      ajv.compile(JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), "utf8")) as object);
    validators = {
      6003: compile("api_activity"),
      3002: compile("authentication"),
      3004: compile("entity_management"),
    };
  }
  return validators;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// problemsOf lists what is wrong with an event's JSON, none for a valid one:
// its class schema's errors, and what OCSF's sources ask beyond the schema,
// type_uid as class_uid * 100 + activity_id, an address within ip_t, and a
// uid that is a UUID.
export function problemsOf(json: string): string[] {
  const event = JSON.parse(json) as OcsfEvent & { src_endpoint?: { ip?: string } };
  const validate = schemas()[event.class_uid];
  if (validate === undefined) {
    return [`class_uid ${event.class_uid} is none the log uses`];
  }
  const problems = validate(event)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
  if (event.type_uid !== event.class_uid * 100 + event.activity_id) {
    problems.push("type_uid is not class_uid * 100 + activity_id");
  }
  const ip = event.src_endpoint?.ip;
  if (ip !== undefined && (isIP(ip) === 0 || ip.length > 40)) {
    problems.push("src_endpoint.ip is not an address ip_t allows");
  }
  if (!uuid.test(event.metadata.uid)) {
    problems.push("metadata.uid is not a UUID");
  }
  return problems;
}
