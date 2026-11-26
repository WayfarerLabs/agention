import type { Color, Scope, WorkOutcome, WorkState } from "@wayfarerlabs/agention-api";

// The audit log's actions: each kind of thing the log records as a success,
// under its stable name, with the OCSF class and activity its event takes and
// how its event names what the action did, from the typed input it is built
// from. An input holds ids, numbers, flags, and the names the operator and
// agents chose for agents, sessions, groups, tags, keys, and passkeys, read
// from rows the store holds. No input takes a request body, message or answer
// text, a title, a file name, or a secret, so none can reach an event.

// JSON as events hold it; a key whose value is undefined is left out, as
// JSON.stringify leaves it out.
export type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// The OCSF classes the log uses: API Activity for writes, Authentication for
// sign-ins and refused keys, and Entity Management for credentials and
// registrations.
export type AuditClass = 6003 | 3002 | 3004;

export const auditClasses = {
  6003: { category: 6, name: "API Activity" },
  3002: { category: 3, name: "Authentication" },
  3004: { category: 3, name: "Entity Management" },
} as const satisfies Record<AuditClass, { category: number; name: string }>;

// Each class's activities, by id, with their captions in OCSF 1.9.0.
export const activityNames: Record<AuditClass, Readonly<Record<number, string>>> = {
  6003: { 1: "Create", 2: "Read", 3: "Update", 4: "Delete" },
  3002: { 1: "Logon", 2: "Logoff" },
  3004: { 1: "Create", 3: "Update", 4: "Delete", 6: "Enroll", 9: "Disable", 10: "Activate" },
};

// The things events name, by their ids and the names they carry.
export interface SessionRef {
  id: number;
  agent: string;
  session: string;
}

export interface AgentRef {
  id: number;
  agent: string;
}

export interface ThreadRef {
  id: number;
  agent: string;
  session: string;
  number: number;
}

export interface GroupRef {
  id: number;
  name: string;
}

// A key's or a passkey's id and the name the operator gave it.
export interface NamedRef {
  id: number;
  name: string;
}

// A registration, named by its agent and session: those granted, or else
// those proposed.
export interface RegistrationRef {
  id: number;
  agent: string;
  session: string;
}

// What a write's session status entry says, for an agent's write that logged
// one, reported or inferred.
export interface LoggedStatus {
  state: WorkState;
  outcome: WorkOutcome | null;
}

// A message a write appended: the numbers of the asks it puts, answers,
// declines, and withdraws, the files it carries by id, the message it
// replaces, and the session status the write logged.
export interface MessageEntry {
  thread: ThreadRef;
  seq: number;
  asks: number[];
  answers: number[];
  declined: number[];
  withdrawals: number[];
  files: number[];
  replaces: number | null;
  status: LoggedStatus | null;
}

// A thread an archive raised the mark of, through the message given.
export interface ArchivedThread {
  thread: ThreadRef;
  through: number;
}

// A browser session a sign-in opened, by its id, the passkey that signed it
// in, and its times.
export interface OpenedSession {
  id: string;
  passkeyId: number;
  createdAt: number;
  expiresAt: number;
}

export type SinkKind = "stdout" | "file";

export type VoiceField = "base_url" | "model" | "prompt" | "api_key";

// What an action's event says of what it did, by its class: API Activity's
// resources, Entity Management's entity, and for Authentication the times of
// the session a sign-in opened and the sessions it ended.
export interface Subject {
  resources?: JsonObject[];
  entity?: JsonObject;
  opened?: { createdAt: number; expiresAt: number };
  ended?: string[];
}

interface ActionShape<I> {
  class: AuditClass;
  activity: number;
  // The action's own caption, for activity 99, Other.
  label?: string;
  build: (input: I) => Subject;
}

const write = <I>(activity: number, resources: (input: I) => JsonObject[]): ActionShape<I> => ({
  class: 6003,
  activity,
  build: (input) => ({ resources: resources(input) }),
});

const managed = <I>(
  activity: number,
  entity: (input: I) => JsonObject,
  label?: string,
): ActionShape<I> => ({
  class: 3004,
  activity,
  ...(label === undefined ? {} : { label }),
  build: (input) => ({ entity: entity(input) }),
});

const authentication = <I>(activity: number, build: (input: I) => Subject): ActionShape<I> => ({
  class: 3002,
  activity,
  build,
});

const sessionName = (ref: { agent: string; session: string }) => `${ref.agent}/${ref.session}`;

const sessionResource = (ref: SessionRef, data?: JsonObject): JsonObject => ({
  type: "session",
  uid: `session:${ref.id}`,
  name: sessionName(ref),
  data,
});

const threadResource = (ref: ThreadRef, data?: JsonObject): JsonObject => ({
  type: "thread",
  uid: `thread:${ref.id}`,
  name: `${sessionName(ref)}/${ref.number}`,
  data,
});

const statusData = (status: LoggedStatus | null): Json =>
  status === null ? null : { state: status.state, outcome: status.outcome ?? undefined };

const messageResource = (message: MessageEntry): JsonObject => ({
  type: "message",
  uid: `message:${message.thread.id}/${message.seq}`,
  name: `${sessionName(message.thread)}/${message.thread.number}/${message.seq}`,
  data: {
    asks: message.asks,
    answers: message.answers,
    declined: message.declined,
    withdrawals: message.withdrawals,
    files: message.files.map((id) => `file:${id}`),
    replaces: message.replaces,
    status: statusData(message.status),
  },
});

const fileResource = (id: number, data?: JsonObject): JsonObject => ({
  type: "file",
  uid: `file:${id}`,
  data,
});

const groupResource = (group: GroupRef, data?: JsonObject): JsonObject => ({
  type: "group",
  uid: `group:${group.id}`,
  name: group.name,
  data,
});

const tagResource = (tag: string, data?: JsonObject): JsonObject => ({
  type: "tag",
  uid: `tag:${tag}`,
  name: tag,
  data,
});

const voiceResource = (data?: JsonObject): JsonObject => ({
  type: "voice_settings",
  uid: "voice_settings",
  data,
});

const entity = (
  kind: { type: string; uid?: string; name: string },
  data?: JsonObject,
): JsonObject => ({ uid: kind.uid, name: kind.name, type: kind.type, type_id: 99, data });

const keyEntity = (key: NamedRef, data?: JsonObject) =>
  entity({ type: "API key", uid: `api_key:${key.id}`, name: key.name }, data);

const passkeyEntity = (passkey: NamedRef, data?: JsonObject) =>
  entity({ type: "Passkey", uid: `passkey:${passkey.id}`, name: passkey.name }, data);

const registrationEntity = (registration: RegistrationRef, data?: JsonObject) =>
  entity(
    {
      type: "Registration",
      uid: `registration:${registration.id}`,
      name: sessionName(registration),
    },
    data,
  );

// The operator, as a user.
export const operatorUser = (person: NamedRef): JsonObject => ({
  uid: `person:${person.id}`,
  name: person.name,
  type_id: 2,
});

export const browserSessions = (ids: string[]): Json => ids.map((id) => `browser_session:${id}`);

const archived = (input: { archived: ArchivedThread[] }) =>
  input.archived.map(({ thread, through }) => threadResource(thread, { through }));

const archivedAndDeclined = (input: { archived: ArchivedThread[]; declines: MessageEntry[] }) => [
  ...archived(input),
  ...input.declines.map(messageResource),
];

interface StartedThread {
  session: SessionRef;
  thread: ThreadRef;
  message: MessageEntry;
}

const started = (input: StartedThread) => [
  sessionResource(input.session),
  threadResource(input.thread),
  messageResource(input.message),
];

interface SignedIn {
  session: OpenedSession;
  endedSessions: string[];
}

const signedIn = (input: SignedIn): Subject => ({
  opened: { createdAt: input.session.createdAt, expiresAt: input.session.expiresAt },
  ended: input.endedSessions,
});

// The action table. An operation's declaration takes its action's name, so
// the coverage test finds every write here.
export const auditActions = {
  createThread: write(1, started),
  startThread: write(1, started),
  sendMessage: write(1, (input: { thread: ThreadRef; message: MessageEntry }) => [
    threadResource(input.thread),
    messageResource(input.message),
  ]),
  archiveThread: write(
    3,
    (input: { thread: ThreadRef; through: number; status: LoggedStatus | null }) => [
      threadResource(input.thread, { through: input.through, status: statusData(input.status) }),
    ],
  ),
  bulkArchive: write(3, archived),
  actOnThreads: write(3, archivedAndDeclined),
  actOnMatchingThreads: write(3, archivedAndDeclined),
  uploadFile: write(
    1,
    (input: { file: number; size: number; mediaType: string; session: number }) => [
      fileResource(input.file, {
        size: input.size,
        media_type: input.mediaType,
        session: `session:${input.session}`,
      }),
    ],
  ),
  removeUpload: write(4, (input: { file: number }) => [fileResource(input.file)]),
  createGroup: write(1, (input: { group: GroupRef; color: Color; position: number }) => [
    groupResource(input.group, { color: input.color, position: input.position }),
  ]),
  renameGroup: write(3, (input: { group: GroupRef; previousName: string }) => [
    groupResource(input.group, { previous_name: input.previousName }),
  ]),
  recolorGroup: write(3, (input: { group: GroupRef; color: Color }) => [
    groupResource(input.group, { color: input.color }),
  ]),
  orderGroups: write(3, (input: { groups: { group: GroupRef; position: number }[] }) =>
    input.groups.map(({ group, position }) => groupResource(group, { position })),
  ),
  removeGroup: write(4, (input: { group: GroupRef; sessions: number }) => [
    groupResource(input.group, { sessions: input.sessions }),
  ]),
  createTag: write(1, (input: { tag: string; color: Color }) => [
    tagResource(input.tag, { color: input.color }),
  ]),
  renameTag: write(3, (input: { tag: string; previousName: string }) => [
    tagResource(input.tag, { previous_name: input.previousName }),
  ]),
  recolorTag: write(3, (input: { tag: string; color: Color }) => [
    tagResource(input.tag, { color: input.color }),
  ]),
  removeTag: write(4, (input: { tag: string }) => [tagResource(input.tag)]),
  setSessionGroup: write(3, (input: { session: SessionRef; group: number | null }) => [
    sessionResource(input.session, {
      group: input.group === null ? null : `group:${input.group}`,
    }),
  ]),
  setSessionTags: write(
    3,
    (input: { session: SessionRef; tags: string[]; createdTags: string[] }) => [
      sessionResource(input.session, { tags: input.tags, created_tags: input.createdTags }),
    ],
  ),
  setAgentTags: write(3, (input: { agent: AgentRef; tags: string[]; createdTags: string[] }) => [
    {
      type: "agent",
      uid: `agent:${input.agent.id}`,
      name: input.agent.agent,
      data: { tags: input.tags, created_tags: input.createdTags },
    },
  ]),
  updateSession: write(
    1,
    (input: {
      session: SessionRef;
      update: number;
      state: WorkState;
      outcome: WorkOutcome | null;
      percent: number | null;
    }) => [
      sessionResource(input.session, {
        update: input.update,
        state: input.state,
        outcome: input.outcome,
        percent: input.percent,
      }),
    ],
  ),
  setVoiceSettings: write(3, (input: { changed: VoiceField[] }) => [
    voiceResource({ changed: input.changed }),
  ]),
  clearVoiceSettings: write(4, (_input: Record<string, never>) => [voiceResource()]),
  forgetSink: write(4, (input: { sink: SinkKind; deliveredSeq: number }) => [
    {
      type: "audit_sink",
      uid: `audit_sink:${input.sink}`,
      name: input.sink,
      data: { delivered_seq: input.deliveredSeq },
    },
  ]),
  signIn: authentication(1, signedIn),
  usePasskeyLink: authentication(1, signedIn),
  signOut: authentication(2, (_input: Record<string, never>) => ({})),
  createApiKey: managed(1, (input: { key: NamedRef; scopes: Scope[]; expiresAt: number | null }) =>
    keyEntity(input.key, { scopes: input.scopes, expiration_time: input.expiresAt }),
  ),
  revokeApiKey: managed(9, (input: { key: NamedRef }) => keyEntity(input.key)),
  activateApiKey: managed(10, (input: { key: NamedRef }) => keyEntity(input.key)),
  addPasskey: managed(1, (input: { passkey: NamedRef }) => passkeyEntity(input.passkey)),
  renamePasskey: managed(3, (input: { passkey: NamedRef; previousName: string }) =>
    passkeyEntity(input.passkey, { previous_name: input.previousName }),
  ),
  removePasskey: managed(4, (input: { passkey: NamedRef; endedSessions: string[] }) =>
    passkeyEntity(input.passkey, { ended_sessions: browserSessions(input.endedSessions) }),
  ),
  replacePasskey: managed(4, (input: { passkey: NamedRef }) => passkeyEntity(input.passkey)),
  createOperator: managed(1, (input: { operator: NamedRef }) => ({
    uid: `person:${input.operator.id}`,
    name: input.operator.name,
    type: "User",
    type_id: 2,
    user: operatorUser(input.operator),
  })),
  register: managed(
    1,
    (input: {
      registration: RegistrationRef;
      proposedAgent: string;
      proposedSession: string;
      expiresAt: number;
    }) =>
      registrationEntity(input.registration, {
        proposed_agent: input.proposedAgent,
        proposed_session: input.proposedSession,
        expiration_time: input.expiresAt,
      }),
  ),
  approveRegistration: managed(
    6,
    (input: {
      registration: RegistrationRef;
      session: number;
      newAgent: boolean;
      newSession: boolean;
      // The group and tags the approval gave the session, when it gave them.
      group?: number | null;
      tags?: string[];
    }) =>
      registrationEntity(input.registration, {
        session: `session:${input.session}`,
        new_agent: input.newAgent,
        new_session: input.newSession,
        group:
          input.group === undefined
            ? undefined
            : input.group === null
              ? null
              : `group:${input.group}`,
        tags: input.tags,
      }),
  ),
  rejectRegistration: managed(
    99,
    (input: { registration: RegistrationRef }) => registrationEntity(input.registration),
    "Reject",
  ),
  revokeRegistration: managed(9, (input: { registration: RegistrationRef }) =>
    registrationEntity(input.registration),
  ),
  issuePasskeyLink: managed(1, (input: { expiresAt: number; replacesPasskeys: boolean }) =>
    entity(
      { type: "Passkey link", name: "passkey link" },
      { expiration_time: input.expiresAt, replaces_passkeys: input.replacesPasskeys },
    ),
  ),
};

// The actions a success records, and each one's input, as its build takes it.
export type AuditAction = keyof typeof auditActions;
export type AuditInput<A extends AuditAction> = Parameters<(typeof auditActions)[A]["build"]>[0];

// isAuditAction says whether a name is an action in the table.
export function isAuditAction(name: string): name is AuditAction {
  return Object.hasOwn(auditActions, name);
}

// refusedActivity is the activity of a scope refusal of an operation: Read
// for a GET, the operation's own for a write recorded as API Activity, and
// Update for any other write, such as a registration's decision or a read
// mark.
export function refusedActivity(operation: string, method: "GET" | "HEAD" | "POST"): number {
  if (method !== "POST") {
    return 2;
  }
  const shape = isAuditAction(operation) ? auditActions[operation] : undefined;
  return shape?.class === 6003 ? shape.activity : 3;
}

// A failure the log records, coalesced with others of its kind: a sign-in or
// a link that failed, an API key the server found but refused as revoked or
// expired, or a live key refused a scope, with the operation refused and its
// activity. Only failures ever record authenticateApiKey and authorizeScope,
// so the table holds neither. A key refused once its answer was already under
// way, as a download's later chunk refuses it, is unanswered: its client saw
// the answer cut short, never the refusal.
export type AuditFailure =
  | { action: "signIn" | "usePasskeyLink" }
  | { action: "authenticateApiKey"; code: "key_revoked" | "key_expired"; unanswered?: true }
  | { action: "authorizeScope"; operation: string; activity: number };
