// A store over a fresh database, with an operator and helpers to register
// agents and write to threads, for the store's tests.
import {
  type MessageSendInput,
  messageSendInput,
  type PublicKey,
  publicKey,
  type ThreadCreateInput,
  threadCreateInput,
  threadGetQuery,
} from "@wayfarerlabs/agention-api";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../database/database.ts";
import { type Identity, identityForBrowserSession, identityForRegistration } from "../identity.ts";
import { insertOperator } from "./directory.ts";
import { markSeen } from "./presence.ts";
import { approveRegistration, submitRegistration } from "./registrations.ts";
import { createStore, type Store } from "./store.ts";
import {
  createThread,
  getThread,
  sendMessage,
  type SessionTarget,
  type ThreadTarget,
} from "./threads.ts";

export const start = Date.UTC(2026, 9, 27, 12);
export const hour = 60 * 60 * 1000;

export interface Agent {
  identity: Identity;
  registrationId: number;
  publicKey: PublicKey;
  target: SessionTarget;
  sessionId: number;
}

export function newPublicKey(): PublicKey {
  return publicKey.parse(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x);
}

// insertTestPasskey stores a passkey of the person's that no authenticator
// holds, for the browser sessions tests open directly, and returns its id.
export function insertTestPasskey(db: Database, personId: number, now: number): number {
  const data = {
    public_key: "",
    counter: 0,
    transports: [],
    user_handle: randomBytes(32).toString("base64url"),
    device_type: "singleDevice",
    backed_up: false,
  };
  const { id } = db
    .prepare(
      `INSERT INTO passkeys (person_id, credential_id, name, data, created_at)
       VALUES (?, ?, 'Test passkey', ?, ?) RETURNING id`,
    )
    .get(personId, randomBytes(16).toString("base64url"), JSON.stringify(data), now) as {
    id: number;
  };
  return id;
}

let requestCounter = 0;

export function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export class Fixture {
  readonly root: string;
  readonly db: Database;
  readonly store: Store;
  readonly operator: Identity;
  readonly browserSession: Uint8Array;
  // The passkey the operator's browser session was signed in with.
  readonly passkeyId: number;
  now = start;

  // options.quietAfter is how long a session goes unseen before it is quiet,
  // by default the server's own.
  constructor(options: { quietAfter?: number } = {}) {
    this.root = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-store-")));
    this.db = Database.open(path.join(this.root, "agention.db"));
    this.store = createStore(this.db, { clock: () => this.now, ...options });
    this.browserSession = randomBytes(32);
    this.passkeyId = this.db.transaction(() => {
      const operator = insertOperator(this.db, "operator", this.now);
      const passkeyId = insertTestPasskey(this.db, operator.personId, this.now);
      this.db
        .prepare(
          `INSERT INTO browser_sessions (hash, person_id, passkey_id, csrf_token, created_at,
             idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, 'csrf', ?, ?, ?)`,
        )
        .run(
          this.browserSession,
          operator.personId,
          passkeyId,
          this.now,
          this.now + 7 * 24 * hour,
          this.now + 30 * 24 * hour,
        );
      return passkeyId;
    });
    const operator = identityForBrowserSession(this.db, this.browserSession);
    if (operator === undefined) {
      throw new Error("no operator identity");
    }
    this.operator = operator;
  }

  close(): void {
    this.db.close();
    rmSync(this.root, { recursive: true, force: true });
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
  }

  // registerAgent submits a new key and approves it for agent/session, creating
  // either when it does not exist yet.
  registerAgent(agent: string, session: string): Agent {
    const key = newPublicKey();
    submitRegistration(this.store, key, { agent, session });
    const { id } = this.db
      .prepare("SELECT id FROM registrations WHERE public_key = ?")
      .get(key) as {
      id: number;
    };
    const agentExists =
      this.db.prepare("SELECT 1 FROM agents WHERE name = ?").get(agent) !== undefined;
    const sessionExists =
      this.db
        .prepare(
          "SELECT 1 FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE a.name = ? AND s.name = ?",
        )
        .get(agent, session) !== undefined;
    approveRegistration(this.store, this.operator, id, {
      agent: { name: agent, existing: agentExists },
      session: { name: session, existing: sessionExists },
    });
    const identity = identityForRegistration(this.db, id);
    if (identity === undefined) {
      throw new Error("no agent identity");
    }
    const { sessions } = identity.grants;
    return {
      identity,
      registrationId: id,
      publicKey: key,
      target: { agent, session },
      sessionId: sessions === "all" ? 0 : (sessions[0] ?? 0),
    };
  }

  // seen marks the agent's session seen now, as each of its calls does.
  seen(agent: Agent): void {
    markSeen(this.store, agent.registrationId);
  }

  // createThread creates a thread from fields the schema parses, by default
  // with a title alone.
  createThread(agent: Agent, fields: Partial<Record<keyof ThreadCreateInput, unknown>> = {}) {
    const input = threadCreateInput.parse({
      request_id: requestId(),
      title: "A question",
      ...fields,
    });
    return createThread(this.store, agent.identity, agent.target, input);
  }

  // thread reads a thread, with up to 100 messages, as the identity sees it.
  thread(identity: Identity, target: ThreadTarget) {
    return getThread(this.store, identity, target, threadGetQuery.parse({ limit: "100" }));
  }

  // lastSeq reads a thread's latest message sequence.
  lastSeq(target: ThreadTarget): number {
    const row = this.db
      .prepare(
        `SELECT t.last_seq FROM threads t JOIN sessions s ON s.id = t.session_id
         JOIN agents a ON a.id = s.agent_id
         WHERE a.name = ? AND s.name = ? AND t.number = ?`,
      )
      .get(target.agent, target.session, target.thread) as { last_seq: number } | undefined;
    return row?.last_seq ?? 0;
  }

  // write sends a message, by default having seen the thread's latest message.
  write(
    identity: Identity,
    target: ThreadTarget,
    fields: Partial<Record<keyof MessageSendInput, unknown>>,
  ) {
    const input = messageSendInput.parse({
      request_id: requestId(),
      ...fields,
      seen_through: fields.seen_through ?? this.lastSeq(target),
    });
    return sendMessage(this.store, identity, target, input);
  }
}

export function threadTarget(agent: Agent, thread: number): ThreadTarget {
  return { ...agent.target, thread };
}
