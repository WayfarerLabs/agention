// The SQLite application id, `AGN1` in ASCII, which marks a database file as
// Agention's in its header.
export const applicationId = 0x41474e31;

// Migrations, in order. PRAGMA user_version records how many have run; each
// runs in its own transaction with the bump. Append new migrations, each with
// its hash in migrations.test.ts, which freezes them all; never edit one that
// has shipped.
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
  `
  -- The operator's session groups. A group keeps its id when renamed, and ids
  -- never repeat, so a filter, fold or action naming a removed group never
  -- reaches a group made after it.
  CREATE TABLE session_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- A session's group. Keyed on the session, so a session sits in at most one.
  CREATE TABLE session_group_members (
    session_id INTEGER PRIMARY KEY REFERENCES sessions (id),
    group_id INTEGER NOT NULL REFERENCES session_groups (id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX session_group_members_groups ON session_group_members (group_id);

  -- Tags are names on agents and sessions; a tag exists while something carries it.
  CREATE TABLE agent_tags (
    agent_id INTEGER NOT NULL REFERENCES agents (id),
    name TEXT NOT NULL,
    PRIMARY KEY (agent_id, name)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX agent_tags_names ON agent_tags (name);

  CREATE TABLE session_tags (
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    name TEXT NOT NULL,
    PRIMARY KEY (session_id, name)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX session_tags_names ON session_tags (name);

  -- The search index of what messages say, matched as the titles' index is. It
  -- keeps no copy of the text, only each message's thread and sequence, since a
  -- message has no integer key of its own for an external-content index to rest
  -- on. Messages are append-only, so a message goes in as it is written; the
  -- migration indexes those before it.
  CREATE VIRTUAL TABLE message_texts USING fts5 (
    text, detail,
    thread_id UNINDEXED, seq UNINDEXED,
    content = '', contentless_unindexed = 1,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER messages_index_text AFTER INSERT ON messages WHEN new.text IS NOT NULL
  BEGIN
    INSERT INTO message_texts (text, detail, thread_id, seq)
    VALUES (new.text, new.detail, new.thread_id, new.seq);
  END;
  INSERT INTO message_texts (text, detail, thread_id, seq)
    SELECT text, detail, thread_id, seq FROM messages WHERE text IS NOT NULL;
  `,
  `
  -- What Settings last saved for voice: at most one row. base_url and model
  -- are the values in effect when it was saved, including any the server's
  -- environment supplied, so the row always records the address its key was
  -- entered for. Turning voice off deletes the row.
  CREATE TABLE voice_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT,
    api_key TEXT
  ) STRICT;
  `,
  `
  -- Every uploaded file. Its bytes are rows of file_chunks, 1 MiB each but the
  -- last, numbered from 0. size is the length the upload declared, known
  -- before any byte arrives. A file is incomplete until every byte has arrived
  -- (completed_at, with its SHA-256), and pending until a message first names
  -- it (attached_at). ref is the random reference an upload answers with and
  -- messages name it by. A file belongs to the session it was uploaded under
  -- and to the actor that uploaded it; registration_id records the credential
  -- behind an agent's upload. name and type are as the uploader gave them: the
  -- name the file is attached under unless the message names another, and the
  -- declared type, which serving maps onto its allowlist.
  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE CHECK (length(ref) = 22),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 127),
    size INTEGER NOT NULL CHECK (size >= 0),
    actor_id INTEGER NOT NULL REFERENCES actors (id),
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    registration_id INTEGER REFERENCES registrations (id),
    created_at INTEGER NOT NULL,
    sha256 BLOB CHECK (sha256 IS NULL OR length(sha256) = 32),
    completed_at INTEGER,
    attached_at INTEGER,
    CHECK ((sha256 IS NULL) = (completed_at IS NULL)),
    CHECK (attached_at IS NULL OR completed_at IS NOT NULL)
  ) STRICT;

  CREATE INDEX files_pending ON files (actor_id) WHERE attached_at IS NULL;

  CREATE TRIGGER files_fixed BEFORE UPDATE ON files
  WHEN new.id IS NOT old.id OR new.ref IS NOT old.ref OR new.name IS NOT old.name
    OR new.type IS NOT old.type OR new.size IS NOT old.size OR new.actor_id IS NOT old.actor_id
    OR new.session_id IS NOT old.session_id OR new.registration_id IS NOT old.registration_id
    OR new.created_at IS NOT old.created_at
    OR (old.completed_at IS NOT NULL AND (new.completed_at IS NOT old.completed_at
      OR new.sha256 IS NOT old.sha256))
    OR (old.attached_at IS NOT NULL AND new.attached_at IS NOT old.attached_at)
  BEGIN
    SELECT RAISE(ABORT, 'a file changes only as its upload arrives and a message first names it');
  END;
  CREATE TRIGGER files_attached_kept BEFORE DELETE ON files WHEN old.attached_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'an attached file is never removed');
  END;

  -- A file's bytes, in order. A rowid table on purpose: rows of 1 MiB would
  -- make a WITHOUT ROWID b-tree's pages hold one row each.
  CREATE TABLE file_chunks (
    file_id INTEGER NOT NULL REFERENCES files (id),
    idx INTEGER NOT NULL CHECK (idx >= 0),
    data BLOB NOT NULL,
    PRIMARY KEY (file_id, idx)
  ) STRICT;

  CREATE TRIGGER file_chunks_fixed BEFORE UPDATE ON file_chunks
  BEGIN
    SELECT RAISE(ABORT, 'a file''s bytes never change');
  END;
  CREATE TRIGGER file_chunks_kept BEFORE DELETE ON file_chunks
  WHEN (SELECT attached_at FROM files WHERE id = old.file_id) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'an attached file keeps its bytes');
  END;

  -- The files each message carries, in the order it gave them, each under a
  -- name unique within the message. A message carries a file it uploaded, or
  -- one the message it replaces carries, which it names again. Append-only, as
  -- messages are. Naming a file attaches it, for good.
  CREATE TABLE attachments (
    thread_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL,
    file_id INTEGER NOT NULL REFERENCES files (id),
    PRIMARY KEY (thread_id, seq, position),
    UNIQUE (thread_id, seq, name),
    FOREIGN KEY (thread_id, seq) REFERENCES messages (thread_id, seq)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX attachments_files ON attachments (file_id);

  CREATE TRIGGER attachments_no_update BEFORE UPDATE ON attachments
  BEGIN
    SELECT RAISE(ABORT, 'attachments are append-only');
  END;
  CREATE TRIGGER attachments_no_delete BEFORE DELETE ON attachments
  BEGIN
    SELECT RAISE(ABORT, 'attachments are append-only');
  END;
  CREATE TRIGGER attachments_attach AFTER INSERT ON attachments
  BEGIN
    UPDATE files SET attached_at = (
      SELECT created_at FROM messages WHERE thread_id = new.thread_id AND seq = new.seq
    ) WHERE id = new.file_id AND attached_at IS NULL;
  END;
  `,
  `
  -- The operator's API keys. hash is the SHA-256 of the key's secret, which
  -- only its holder keeps. scopes is the JSON array of the scopes it holds.
  -- expires_at is null for a key without an expiry. last_used_at is kept to
  -- the hour. A revoked or expired key keeps its row, so the list can show it,
  -- until the operator next creates or revokes a key; ids never repeat, so an
  -- id names one key for good.
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people (id),
    name TEXT NOT NULL,
    scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
    hash BLOB NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER CHECK (expires_at > created_at),
    last_used_at INTEGER,
    revoked_at INTEGER
  ) STRICT;
  `,
  `
  -- Each message's position in the whole database, in the order messages are
  -- written, which the operator's wait across sessions counts from. A message
  -- table's rowid will not do: it is no column's alias, so VACUUM may renumber
  -- it. pos is an INTEGER PRIMARY KEY, which keeps its values, and
  -- AUTOINCREMENT never reuses one, so a position never goes backwards. A
  -- message takes its position as it is written; the migration numbers those
  -- before it in the order they are stored.
  CREATE TABLE message_positions (
    pos INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    UNIQUE (thread_id, seq),
    FOREIGN KEY (thread_id, seq) REFERENCES messages (thread_id, seq)
  ) STRICT;
  CREATE TRIGGER messages_position AFTER INSERT ON messages
  BEGIN
    INSERT INTO message_positions (thread_id, seq) VALUES (new.thread_id, new.seq);
  END;
  CREATE TRIGGER message_positions_no_update BEFORE UPDATE ON message_positions
  BEGIN
    SELECT RAISE(ABORT, 'message positions are append-only');
  END;
  CREATE TRIGGER message_positions_no_delete BEFORE DELETE ON message_positions
  BEGIN
    SELECT RAISE(ABORT, 'message positions are append-only');
  END;
  INSERT INTO message_positions (thread_id, seq)
    SELECT thread_id, seq FROM messages ORDER BY rowid;
  `,
  `
  -- Whether the server inferred a session's log entry rather than the session
  -- reporting it: one logged when the session wrote to a thread while idle,
  -- which marks it working and carries no note. Every earlier entry was
  -- reported.
  ALTER TABLE session_updates ADD COLUMN inferred INTEGER NOT NULL DEFAULT 0
    CHECK (inferred = 0 OR (inferred = 1 AND state = 'working' AND note IS NULL));
  `,
  `
  -- Colors and the operator's order for groups, and tags as rows of their
  -- own. A color is one of a fixed palette. Groups keep the order they were
  -- listed in, by name, as their positions, unique and counted from 1, and
  -- each takes the palette's colors in turn by its id. A tag exists until it
  -- is removed: every tag carried becomes a row, keyed by its name, taking
  -- the palette's colors in turn in name order, and agent_tags and
  -- session_tags, rebuilt to name it by a foreign key, follow its renaming
  -- and its removal.
  ALTER TABLE session_groups ADD COLUMN color TEXT NOT NULL DEFAULT 'gray'
    CHECK (color IN ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple'));
  ALTER TABLE session_groups ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
  UPDATE session_groups SET
    color = json_extract(
      '["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple"]',
      '$[' || ((id - 1) % 8) || ']'
    ),
    position = ordered.place
  FROM (SELECT id AS ordered_id, row_number() OVER (ORDER BY name, id) AS place
        FROM session_groups) ordered
  WHERE ordered.ordered_id = session_groups.id;
  CREATE UNIQUE INDEX session_groups_positions ON session_groups (position);

  CREATE TABLE tags (
    name TEXT PRIMARY KEY,
    color TEXT NOT NULL
      CHECK (color IN ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple'))
  ) STRICT, WITHOUT ROWID;
  INSERT INTO tags (name, color)
    SELECT name, json_extract(
      '["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple"]',
      '$[' || ((row_number() OVER (ORDER BY name) - 1) % 8) || ']'
    )
    FROM (SELECT name FROM agent_tags UNION SELECT name FROM session_tags);

  CREATE TABLE carried_agent_tags (
    agent_id INTEGER NOT NULL REFERENCES agents (id),
    name TEXT NOT NULL REFERENCES tags (name) ON UPDATE CASCADE ON DELETE CASCADE,
    PRIMARY KEY (agent_id, name)
  ) STRICT, WITHOUT ROWID;
  INSERT INTO carried_agent_tags (agent_id, name) SELECT agent_id, name FROM agent_tags;
  DROP TABLE agent_tags;
  ALTER TABLE carried_agent_tags RENAME TO agent_tags;
  CREATE INDEX agent_tags_names ON agent_tags (name);

  CREATE TABLE carried_session_tags (
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    name TEXT NOT NULL REFERENCES tags (name) ON UPDATE CASCADE ON DELETE CASCADE,
    PRIMARY KEY (session_id, name)
  ) STRICT, WITHOUT ROWID;
  INSERT INTO carried_session_tags (session_id, name) SELECT session_id, name FROM session_tags;
  DROP TABLE session_tags;
  ALTER TABLE carried_session_tags RENAME TO session_tags;
  CREATE INDEX session_tags_names ON session_tags (name);
  `,
  `
  -- The pull requests and branches each message names, in the order it gave
  -- them, a list of each. link_key is an entry's identity: its short form,
  -- owner/name#number or owner/name:branch, with the repository's owner and
  -- name lower-cased. repo, branch and url are as written. Append-only, as
  -- messages are.
  CREATE TABLE message_links (
    thread_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pull_request', 'branch')),
    position INTEGER NOT NULL CHECK (position >= 0),
    link_key TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER CHECK (number > 0),
    branch TEXT,
    url TEXT,
    CHECK (IIF(kind = 'pull_request', number IS NOT NULL AND branch IS NULL,
      number IS NULL AND branch IS NOT NULL)),
    PRIMARY KEY (thread_id, seq, kind, position),
    UNIQUE (thread_id, seq, link_key),
    FOREIGN KEY (thread_id, seq) REFERENCES messages (thread_id, seq)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX message_links_keys ON message_links (link_key);

  CREATE TRIGGER message_links_no_update BEFORE UPDATE ON message_links
  BEGIN
    SELECT RAISE(ABORT, 'message links are append-only');
  END;
  CREATE TRIGGER message_links_no_delete BEFORE DELETE ON message_links
  BEGIN
    SELECT RAISE(ABORT, 'message links are append-only');
  END;
  `,
  `
  -- Monitoring. last_seen_at is now when the session's agent last checked
  -- in, any call but its bridge's background ones, and last_seen_version the
  -- agent API version of the call that stamped it, null for a stamp made
  -- before this migration, which came from a version below 8. background_at
  -- is when its bridge last made a background request, null until one does.
  ALTER TABLE sessions ADD COLUMN last_seen_version INTEGER CHECK (last_seen_version >= 1);
  ALTER TABLE sessions ADD COLUMN background_at INTEGER;

  -- The latest report of a session's bridge, which replaces the one before
  -- it: whether it monitors a pane, and while it does, the profile it reads
  -- it with, the session's condition and since when, and what stopped it at
  -- rest, with when a usage limit resets where the host shows it. Profiles
  -- are added as harnesses are, so a profile's name is checked where the
  -- report arrives, not here.
  CREATE TABLE monitor_reports (
    session_id INTEGER PRIMARY KEY REFERENCES sessions (id),
    monitored INTEGER NOT NULL CHECK (monitored IN (0, 1)),
    profile TEXT,
    condition TEXT CHECK (condition IN
      ('unknown', 'permission_prompt', 'other_prompt', 'running', 'at_prompt', 'waiting')),
    since INTEGER,
    stopped_by TEXT CHECK (stopped_by IN ('usage_limit', 'block', 'error')),
    resets_at INTEGER,
    CHECK (monitored = (profile IS NOT NULL)),
    CHECK (monitored = (condition IS NOT NULL)),
    CHECK (monitored = (since IS NOT NULL)),
    CHECK (stopped_by IS NULL OR condition IN
      ('permission_prompt', 'other_prompt', 'at_prompt', 'waiting')),
    CHECK (resets_at IS NULL OR stopped_by IS 'usage_limit')
  ) STRICT;
  `,
  `
  -- The nudge. A report's nudge says whether the session can be nudged, as
  -- its bridge last observed, 0 from a bridge older than the nudge, and only
  -- ever 1 while it monitors a pane.
  ALTER TABLE monitor_reports ADD COLUMN nudge INTEGER NOT NULL DEFAULT 0
    CHECK (nudge IN (0, 1) AND (nudge = 0 OR monitored = 1));

  -- Why the bridge cannot monitor or nudge, one of a fixed list, and since
  -- when, by its clock, both null where it can or the bridge does not say.
  ALTER TABLE monitor_reports ADD COLUMN unable TEXT CHECK (unable IN ('no_socket',
    'pane_unreachable', 'not_one_pane', 'unknown_profile', 'unknown_nudge_type', 'nudge_off',
    'generic_profile', 'claims_refused', 'nudge_text_left'));
  ALTER TABLE monitor_reports ADD COLUMN unable_since INTEGER
    CHECK ((unable IS NULL) = (unable_since IS NULL));

  -- A session's nudges. The claim is the attempt a bridge claimed and has
  -- not yet said the outcome of, so under way: claimed_at, by the server's
  -- clock, the attempt's id and the id of the bridge that claimed it, all
  -- null while there is none. The latest nudge is the latest claim that
  -- settled: when it was claimed, its id, and how it ended, sent, stopped or
  -- failed, all null until one first settles. A deferred attempt releases its
  -- claim and leaves the latest nudge as it was. An orphan is a claim whose
  -- bridge left it under way, as another bridge took the session;
  -- nudge_orphan_claimed_at is when the latest orphan released was claimed,
  -- null until one is, so a second orphan since the agent last checked in
  -- settles as failed instead.
  ALTER TABLE sessions ADD COLUMN nudge_claimed_at INTEGER;
  ALTER TABLE sessions ADD COLUMN nudge_claim_id TEXT
    CHECK ((nudge_claim_id IS NULL) = (nudge_claimed_at IS NULL));
  ALTER TABLE sessions ADD COLUMN nudge_claim_bridge TEXT
    CHECK ((nudge_claim_bridge IS NULL) = (nudge_claimed_at IS NULL));
  ALTER TABLE sessions ADD COLUMN nudge_orphan_claimed_at INTEGER;
  ALTER TABLE sessions ADD COLUMN nudged_at INTEGER;
  ALTER TABLE sessions ADD COLUMN nudge_id TEXT CHECK ((nudge_id IS NULL) = (nudged_at IS NULL));
  ALTER TABLE sessions ADD COLUMN nudge_outcome TEXT
    CHECK (nudge_outcome IN ('sent', 'stopped', 'failed')
      AND (nudge_outcome IS NULL) = (nudged_at IS NULL));
  `,
];
