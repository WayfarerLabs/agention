// esbuild copies this import into the bundle, so a built server names the
// version it was built at.
import packageJson from "../../package.json" with { type: "json" };
import { statusByErrorCode } from "@wayfarerlabs/agention-api";
import { hostname } from "node:os";
import type { RequestOrigin } from "../identity.ts";
import {
  activityNames,
  type AuditAction,
  auditActions,
  auditClasses,
  type AuditClass,
  type AuditFailure,
  type AuditInput,
  browserSessions,
  type JsonObject,
  type Subject,
} from "./actions.ts";

// The builder: an action's typed input to its OCSF 1.9.0 event, as the JSON
// the log stores and every sink receives.

export const ocsfVersion = "1.9.0";

// The commands of the command line that record events.
export type CliCommand = "passkey-link" | "audit forget-sink";

export type CredentialKind = "browser_session" | "api_key" | "registration" | "cli" | "none";

// Who an event is by, as its parts name them: the actor, and for a sign-in
// the operator and the browser session they hold; the credential, as the
// event's unmapped credential and the table's columns; and the request, which
// the command line makes none of.
export interface Parts {
  actor: JsonObject | undefined;
  user: JsonObject | undefined;
  session: JsonObject | undefined;
  credential: JsonObject;
  credentialKind: CredentialKind;
  credentialId: string | null;
  origin: RequestOrigin | undefined;
}

// The frame every event shares: its place in the log, its time, the instance
// that records it, and who it is by.
export interface EventFrame {
  seq: number;
  uid: string;
  time: number;
  instance: { uid: string; name: string | undefined };
  by: Parts;
}

// A built event: its JSON, and the fields the table copies for filtering.
export interface BuiltEvent {
  json: string;
  classUid: AuditClass;
  credentialKind: CredentialKind;
  credentialId: string | null;
}

// eventJson writes an event as the log stores it and sinks receive it: JSON,
// with the three characters some readers take for a line's end (NEL, LINE
// SEPARATOR, and PARAGRAPH SEPARATOR), which JSON leaves as they are, escaped,
// so an event is always one line to every reader.
export function eventJson(event: unknown): string {
  return JSON.stringify(event).replace(
    /[\u0085\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// The service a sign-in is to: the server, by its name and origin. The first
// start to serve stores the name before it answers any request.
function serviceOf(frame: EventFrame): JsonObject {
  const { origin } = frame.by;
  if (frame.instance.name === undefined || origin === undefined) {
    throw new Error("a sign-in's event names a server that is serving");
  }
  return { name: frame.instance.name, uid: origin.serverOrigin };
}

// The class's own part of a sign-in: the user signed in or out, their
// session, the service, and how they authenticated.
function authenticationPart(
  frame: EventFrame,
  logon: { protocol: "WebAuthn" | "API key"; mfa: boolean } | undefined,
  session: JsonObject | undefined,
): JsonObject {
  return {
    user: frame.by.user ?? { name: "unknown", type_id: 0 },
    session,
    service: serviceOf(frame),
    auth_protocol_id: logon === undefined ? undefined : 99,
    auth_protocol: logon?.protocol,
    is_mfa: logon?.mfa === true ? true : undefined,
  };
}

// Where the request came from, and the request itself: its routed path for a
// success and its route's pattern for a failure, and the answer the caller
// got when it is known.
function requestPart(
  by: Parts,
  outcome: { path: "path" | "route"; code?: number | undefined },
): JsonObject {
  const { origin } = by;
  if (origin === undefined) {
    return { src_endpoint: { hostname: hostname() } };
  }
  return {
    src_endpoint: origin.ip === undefined ? { name: "unknown" } : { ip: origin.ip },
    http_request: {
      http_method: origin.method,
      url: { path: outcome.path === "path" ? origin.path : origin.route },
      user_agent: origin.userAgent,
    },
    http_response: outcome.code === undefined ? undefined : { code: outcome.code },
  };
}

function head(classUid: AuditClass, activityId: number, activityName: string): JsonObject {
  return {
    class_uid: classUid,
    category_uid: auditClasses[classUid].category,
    activity_id: activityId,
    type_uid: classUid * 100 + activityId,
    class_name: auditClasses[classUid].name,
    activity_name: activityName,
  };
}

function metadata(frame: EventFrame, eventCode: string): JsonObject {
  return {
    version: ocsfVersion,
    product: { name: "Agention", vendor_name: "Wayfarer Labs", version: packageJson.version },
    reporter: { uid: frame.instance.uid, name: frame.instance.name },
    uid: frame.uid,
    sequence: frame.seq,
    log_name: "audit",
    event_code: eventCode,
  };
}

const apiPart = (by: Parts, operation: string): JsonObject => ({
  operation,
  service: { name: by.origin?.service ?? "cli" },
});

function built(frame: EventFrame, classUid: AuditClass, event: JsonObject): BuiltEvent {
  const { credentialKind, credentialId } = frame.by;
  return { json: eventJson(event), classUid, credentialKind, credentialId };
}

// buildEvent builds a success's event.
export function buildEvent<A extends AuditAction>(
  frame: EventFrame,
  action: A,
  input: AuditInput<A>,
): BuiltEvent {
  const shape = auditActions[action];
  const subject = (shape.build as (input: AuditInput<A>) => Subject)(input);
  const activityName =
    "label" in shape && typeof shape.label === "string"
      ? shape.label
      : (activityNames[shape.class][shape.activity] ?? "Other");
  let own: JsonObject;
  if (shape.class === 6003) {
    own = { api: apiPart(frame.by, action), resources: subject.resources };
  } else if (shape.class === 3004) {
    own = { entity: subject.entity };
  } else {
    own = authenticationPart(
      frame,
      shape.activity === 1 ? { protocol: "WebAuthn", mfa: true } : undefined,
      {
        ...frame.by.session,
        created_time: subject.opened?.createdAt,
        expiration_time: subject.opened?.expiresAt,
      },
    );
  }
  const ended = subject.ended ?? [];
  return built(frame, shape.class, {
    ...head(shape.class, shape.activity, activityName),
    time: frame.time,
    severity_id: 1,
    status_id: 1,
    metadata: metadata(frame, action),
    actor: frame.by.actor,
    ...own,
    // A key's first use is recorded as it authenticates, before the
    // operation's schemas have read the path, and before its answer is
    // known, so it names the route's pattern and no answer, as a failure
    // names its route.
    ...requestPart(
      frame.by,
      action === "activateApiKey" ? { path: "route" } : { path: "path", code: 200 },
    ),
    unmapped: {
      credential: frame.by.credential,
      ended_sessions: ended.length === 0 ? undefined : browserSessions(ended),
    },
  });
}

// The status a refusal answers.
const refusedStatus = {
  signIn: statusByErrorCode.unauthenticated,
  usePasskeyLink: statusByErrorCode.unauthenticated,
  authenticateApiKey: statusByErrorCode.unauthenticated,
  authorizeScope: statusByErrorCode.not_found,
} as const;

// failureDetail is a failure's status_detail: a key's refusal's fixed code,
// and none for a failed sign-in or link.
export function failureDetail(failure: AuditFailure): string | undefined {
  switch (failure.action) {
    case "authenticateApiKey":
      return failure.code;
    case "authorizeScope":
      return "scope";
    default:
      return undefined;
  }
}

// failureAnswer is the status a failure's caller was answered with, or
// undefined for a key refused once its answer was under way, which no status
// shows.
export function failureAnswer(failure: AuditFailure): number | undefined {
  return failure.action === "authenticateApiKey" && failure.unanswered === true
    ? undefined
    : refusedStatus[failure.action];
}

// buildFailure builds the first event of a coalesced failure, open for more
// of its kind until its minute ends: its count is 1, and its window starts
// and ends at its time. A scope refusal is API Activity, under the refused
// operation's activity, and any other failure an Authentication Logon.
export function buildFailure(frame: EventFrame, failure: AuditFailure): BuiltEvent {
  const [classUid, activity, own]: [AuditClass, number, JsonObject] =
    failure.action === "authorizeScope"
      ? [6003, failure.activity, { api: apiPart(frame.by, failure.operation) }]
      : [
          3002,
          1,
          authenticationPart(
            frame,
            {
              protocol: failure.action === "authenticateApiKey" ? "API key" : "WebAuthn",
              mfa: false,
            },
            undefined,
          ),
        ];
  return built(frame, classUid, {
    ...head(classUid, activity, activityNames[classUid][activity] ?? "Other"),
    time: frame.time,
    count: 1,
    start_time: frame.time,
    end_time: frame.time,
    severity_id: 2,
    status_id: 2,
    status_detail: failureDetail(failure),
    metadata: metadata(frame, failure.action),
    actor: frame.by.actor,
    ...own,
    ...requestPart(frame.by, { path: "route", code: failureAnswer(failure) }),
    unmapped: { credential: frame.by.credential },
  });
}
