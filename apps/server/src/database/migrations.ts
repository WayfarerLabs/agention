// The SQLite application id, `AGN1` in ASCII, which marks a database file as
// Agention's in its header.
export const applicationId = 0x41474e31;

// Migrations, in order. PRAGMA user_version records how many have run; each
// runs in its own transaction with the bump. Append new migrations; never edit
// one that has shipped, as migrations.test.ts checks.
//
// Conventions: every table is STRICT; times are Unix milliseconds (UTC); text
// columns hold exactly what was submitted; log tables are append-only, enforced
// by triggers.
export const migrations: readonly string[] = [
  `
  -- v1 has exactly one person, the operator.
  CREATE TABLE people (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE agents (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- last_pos is the session's latest message position across all its threads.
  -- last_seen_at is when an approved credential of the session last called,
  -- kept to the minute; null until the first call.
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents (id),
    name TEXT NOT NULL,
    last_pos INTEGER NOT NULL DEFAULT 0 CHECK (last_pos >= 0),
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (agent_id, name)
  ) STRICT;

  -- Messages, marks and thread roles name actors, so roles stay independent of
  -- who an actor is: a session or a person.
  CREATE TABLE actors (
    id INTEGER PRIMARY KEY,
    session_id INTEGER UNIQUE REFERENCES sessions (id),
    person_id INTEGER UNIQUE REFERENCES people (id),
    CHECK ((session_id IS NULL) <> (person_id IS NULL))
  ) STRICT;

  -- One agent credential each: a session key's public half. The session is set
  -- exactly when the registration is approved or revoked; decided_at is when it
  -- was approved or rejected, and revoked_at when it was revoked. Decided
  -- registrations are never deleted; one that expired while pending is, so ids
  -- never repeat.
  CREATE TABLE registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL UNIQUE,
    proposed_agent TEXT NOT NULL,
    proposed_session TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
    session_id INTEGER REFERENCES sessions (id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER,
    revoked_at INTEGER,
    CHECK ((session_id IS NOT NULL) = (status IN ('approved', 'revoked'))),
    CHECK ((decided_at IS NOT NULL) = (status <> 'pending')),
    CHECK ((revoked_at IS NOT NULL) = (status = 'revoked'))
  ) STRICT;

  -- The operator's passkeys, each with the name they gave it.
  CREATE TABLE passkeys (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people (id),
    credential_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  ) STRICT;

  -- This instance's own: the key that seals passkey ceremonies' challenges
  -- into the browser's cookie, made when the database is; and the server's
  -- name, null until the first agention serve to listen stores it, after which
  -- it never changes. The row is never deleted, so no replacement brings
  -- another name.
  CREATE TABLE instance (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    challenge_key BLOB NOT NULL CHECK (length(challenge_key) = 32),
    name TEXT
  ) STRICT;
  INSERT INTO instance (id, challenge_key) VALUES (1, randomblob(32));
  CREATE TRIGGER instance_name_fixed BEFORE UPDATE OF name ON instance
  WHEN old.name IS NOT NULL AND new.name IS NOT old.name
  BEGIN
    SELECT RAISE(ABORT, 'a server''s name never changes');
  END;
  CREATE TRIGGER instance_no_delete BEFORE DELETE ON instance
  BEGIN
    SELECT RAISE(ABORT, 'the instance row is never deleted');
  END;

  -- Browser sessions and passkey links are 256-bit random secrets stored only
  -- as their SHA-256. A session goes with the passkey that signed it in.
  CREATE TABLE browser_sessions (
    hash BLOB PRIMARY KEY CHECK (length(hash) = 32),
    person_id INTEGER NOT NULL REFERENCES people (id),
    passkey_id INTEGER NOT NULL REFERENCES passkeys (id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    idle_expires_at INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  -- The SHA-256 of each challenge a passkey ceremony finished with, kept until
  -- the challenge expires, so a finished ceremony cannot be replayed.
  CREATE TABLE used_challenges (
    hash BLOB PRIMARY KEY CHECK (length(hash) = 32),
    expires_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  -- A passkey link registers the operator's passkey in place of any they
  -- hold, creating them with operator_name the first time.
  CREATE TABLE passkey_links (
    hash BLOB PRIMARY KEY CHECK (length(hash) = 32),
    operator_name TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  -- A thread stores only what never changes, and last_seq, its latest message,
  -- which is all a trigger below lets change. Everything else about it derives
  -- from its messages through the two views below. Thread numbers count from 1
  -- within a session, and references to threads stay within it.
  CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    number INTEGER NOT NULL CHECK (number >= 1),
    requester_actor_id INTEGER NOT NULL REFERENCES actors (id),
    audience_actor_id INTEGER NOT NULL REFERENCES actors (id),
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seq INTEGER NOT NULL CHECK (last_seq >= 1),
    UNIQUE (session_id, number),
    UNIQUE (id, session_id)
  ) STRICT;

  -- The search index of thread titles, word prefixes matched with case and
  -- accents ignored. Its content is the threads table's: a thread's title goes
  -- in as the thread is created, and the index relies on titles never
  -- changing, which the trigger after it holds. Threads are never deleted.
  CREATE VIRTUAL TABLE thread_titles USING fts5 (
    title,
    content = 'threads',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER threads_index_title AFTER INSERT ON threads
  BEGIN
    INSERT INTO thread_titles (rowid, title) VALUES (new.id, new.title);
  END;
  CREATE TRIGGER threads_fixed BEFORE UPDATE ON threads
  WHEN new.id IS NOT old.id OR new.session_id IS NOT old.session_id
    OR new.number IS NOT old.number OR new.requester_actor_id IS NOT old.requester_actor_id
    OR new.audience_actor_id IS NOT old.audience_actor_id OR new.title IS NOT old.title
    OR new.created_at IS NOT old.created_at
  BEGIN
    SELECT RAISE(ABORT, 'a thread changes only its last_seq');
  END;

  -- The append-only log of each thread. session_pos counts the session's
  -- messages from 1. registration_id records the credential behind a session
  -- actor's message. (actor_id, request_id) deduplicates retries.
  --
  -- A message carries any of: text, a summary, with or without its detail,
  -- the long form, which never goes without text; references; asks, answers
  -- and withdrawals, in tables of their own; a topic, which null leaves alone;
  -- and the earlier message it replaces, at most once each.
  -- Only the first message may carry none of them, which the request schemas
  -- hold, since a row here cannot see the rows of its own; the store writes a
  -- message and its rows in one transaction. Who may write each part, and
  -- which earlier messages and asks it may name, depend on the thread's roles
  -- and messages, which the store checks.
  CREATE TABLE messages (
    thread_id INTEGER NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    session_pos INTEGER NOT NULL CHECK (session_pos >= 1),
    actor_id INTEGER NOT NULL REFERENCES actors (id),
    registration_id INTEGER REFERENCES registrations (id),
    created_at INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    digest BLOB NOT NULL CHECK (length(digest) = 32),
    text TEXT,
    detail TEXT CHECK (detail IS NULL OR text IS NOT NULL),
    message_references TEXT
      CHECK (message_references IS NULL OR json_array_length(message_references) > 0),
    replaces_seq INTEGER CHECK (replaces_seq < seq),
    topic TEXT,
    PRIMARY KEY (thread_id, seq),
    UNIQUE (session_id, session_pos),
    UNIQUE (actor_id, request_id),
    UNIQUE (thread_id, replaces_seq),
    FOREIGN KEY (thread_id, session_id) REFERENCES threads (id, session_id),
    FOREIGN KEY (thread_id, replaces_seq) REFERENCES messages (thread_id, seq)
  ) STRICT;

  CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages
  BEGIN
    SELECT RAISE(ABORT, 'messages are append-only');
  END;
  CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
  BEGIN
    SELECT RAISE(ABORT, 'messages are append-only');
  END;

  -- The asks a requester's messages put to the audience. number counts from 1
  -- within the thread in the order asks are written, so it never changes; a
  -- replacement's asks are new rows with new numbers. suggestions is a JSON
  -- array of {label, description}, possibly empty; an ask that allows several
  -- picks suggests at least two.
  CREATE TABLE asks (
    thread_id INTEGER NOT NULL,
    number INTEGER NOT NULL CHECK (number >= 1),
    seq INTEGER NOT NULL,
    question TEXT NOT NULL,
    suggestions TEXT NOT NULL CHECK (json_type(suggestions) = 'array'),
    multiple INTEGER NOT NULL CHECK (multiple IN (0, 1)),
    impact TEXT NOT NULL CHECK (impact IN ('blocking', 'assuming', 'none')),
    priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
    effort TEXT CHECK (effort IN ('quick', 'under_15m', 'under_1h', 'longer')),
    answer_by INTEGER,
    fallback TEXT,
    PRIMARY KEY (thread_id, number),
    FOREIGN KEY (thread_id, seq) REFERENCES messages (thread_id, seq),
    CHECK (multiple = 0 OR json_array_length(suggestions) >= 2)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX asks_messages ON asks (thread_id, seq);

  -- The answers the audience's messages carry, each naming its ask by number,
  -- once per message: a decline, or picks (a JSON array of suggestion indexes)
  -- and the answerer's own words, at least one of them.
  CREATE TABLE answers (
    thread_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    ask INTEGER NOT NULL,
    declined INTEGER NOT NULL CHECK (declined IN (0, 1)),
    picks TEXT CHECK (picks IS NULL OR json_array_length(picks) BETWEEN 1 AND 10),
    text TEXT,
    PRIMARY KEY (thread_id, seq, ask),
    FOREIGN KEY (thread_id, seq) REFERENCES messages (thread_id, seq),
    FOREIGN KEY (thread_id, ask) REFERENCES asks (thread_id, number),
    CHECK ((picks IS NOT NULL OR text IS NOT NULL) = (declined = 0))
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX answers_asks ON answers (thread_id, ask);

  -- The withdrawals the requester's messages carry, each naming an ask by
  -- number, once per message, with the requester's reason.
  CREATE TABLE withdrawals (
    thread_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    ask INTEGER NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq, ask),
    FOREIGN KEY (thread_id, seq) REFERENCES messages (thread_id, seq),
    FOREIGN KEY (thread_id, ask) REFERENCES asks (thread_id, number)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX withdrawals_asks ON withdrawals (thread_id, ask);

  CREATE TRIGGER asks_no_update BEFORE UPDATE ON asks
  BEGIN
    SELECT RAISE(ABORT, 'asks are append-only');
  END;
  CREATE TRIGGER asks_no_delete BEFORE DELETE ON asks
  BEGIN
    SELECT RAISE(ABORT, 'asks are append-only');
  END;
  CREATE TRIGGER answers_no_update BEFORE UPDATE ON answers
  BEGIN
    SELECT RAISE(ABORT, 'answers are append-only');
  END;
  CREATE TRIGGER answers_no_delete BEFORE DELETE ON answers
  BEGIN
    SELECT RAISE(ABORT, 'answers are append-only');
  END;
  CREATE TRIGGER withdrawals_no_update BEFORE UPDATE ON withdrawals
  BEGIN
    SELECT RAISE(ABORT, 'withdrawals are append-only');
  END;
  CREATE TRIGGER withdrawals_no_delete BEFORE DELETE ON withdrawals
  BEGIN
    SELECT RAISE(ABORT, 'withdrawals are append-only');
  END;

  -- The two definitions everything about a thread derives from. A message is
  -- live until a later message replaces it; an ask is open while its message
  -- is live and no live message answers or withdraws it.
  CREATE VIEW live_messages AS
    SELECT m.* FROM messages m
    WHERE NOT EXISTS (
      SELECT 1 FROM messages r WHERE r.thread_id = m.thread_id AND r.replaces_seq = m.seq
    );

  CREATE VIEW open_asks AS
    SELECT a.* FROM asks a
    WHERE EXISTS (SELECT 1 FROM live_messages l WHERE l.thread_id = a.thread_id AND l.seq = a.seq)
      AND NOT EXISTS (
        SELECT 1 FROM answers n
        JOIN live_messages l ON l.thread_id = n.thread_id AND l.seq = n.seq
        WHERE n.thread_id = a.thread_id AND n.ask = a.number
      )
      AND NOT EXISTS (
        SELECT 1 FROM withdrawals w
        JOIN live_messages l ON l.thread_id = w.thread_id AND l.seq = w.seq
        WHERE w.thread_id = a.thread_id AND w.ask = a.number
      );

  -- Each actor's own marks on each thread: how far it has read, which the
  -- other party sees as its read cursor, and how far it has archived, which
  -- only the actor itself ever sees.
  CREATE TABLE thread_marks (
    actor_id INTEGER NOT NULL REFERENCES actors (id),
    thread_id INTEGER NOT NULL REFERENCES threads (id),
    read_seq INTEGER NOT NULL DEFAULT 0 CHECK (read_seq >= 0),
    archived_seq INTEGER NOT NULL DEFAULT 0 CHECK (archived_seq >= 0),
    PRIMARY KEY (actor_id, thread_id)
  ) STRICT, WITHOUT ROWID;
  `,
  `
  -- The append-only log of the status each session reports. An entry holds
  -- the session's whole status after it, so the current status is the entry
  -- with the highest seq, and nothing about it is stored on sessions. seq
  -- counts the session's entries from 1, apart from sessions.last_pos, which
  -- counts its messages. registration_id records the credential behind the
  -- entry. Only a stopped session has an outcome, and a stopped one always
  -- does.
  CREATE TABLE session_updates (
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    seq INTEGER NOT NULL CHECK (seq >= 1),
    registration_id INTEGER NOT NULL REFERENCES registrations (id),
    -- The session's status after this entry.
    state TEXT NOT NULL CHECK (state IN ('working', 'idle', 'stopped')),
    outcome TEXT CHECK (outcome IN ('completed', 'withdrawn', 'stalled')),
    title TEXT,
    goal TEXT,
    percent INTEGER CHECK (percent BETWEEN 0 AND 100),
    -- This entry's own note, which no later entry carries.
    note TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq),
    CHECK ((state = 'stopped') = (outcome IS NOT NULL))
  ) STRICT, WITHOUT ROWID;

  CREATE TRIGGER session_updates_no_update BEFORE UPDATE ON session_updates
  BEGIN
    SELECT RAISE(ABORT, 'session updates are append-only');
  END;
  CREATE TRIGGER session_updates_no_delete BEFORE DELETE ON session_updates
  BEGIN
    SELECT RAISE(ABORT, 'session updates are append-only');
  END;

  -- Each actor's read cursor on each session's log, as thread_marks holds
  -- one on a thread; it is only ever raised.
  CREATE TABLE session_marks (
    actor_id INTEGER NOT NULL REFERENCES actors (id),
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    read_seq INTEGER NOT NULL DEFAULT 0 CHECK (read_seq >= 0),
    PRIMARY KEY (actor_id, session_id)
  ) STRICT, WITHOUT ROWID;
  `,
];
