import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupError, backupDatabase } from "./backup.ts";
import { Database, DatabaseOpenError } from "./database.ts";
import { applicationId, migrations } from "./migrations.ts";

let root: string;
let data: string;
let backups: string;
let source: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-backup-")));
  data = path.join(root, "data");
  backups = path.join(root, "backups");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  source = path.join(data, "agention.db");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mode = (file: string) => statSync(file).mode & 0o7777;

// agentsIn returns the names of the agents a database holds, read without
// changing it or leaving anything beside it.
function agentsIn(file: string): string[] {
  const url = new URL(`file://${file}`);
  url.searchParams.set("immutable", "1");
  const connection = new DatabaseSync(url, { readOnly: true });
  try {
    return (
      connection.prepare("SELECT name FROM agents ORDER BY id").all() as { name: string }[]
    ).map(({ name }) => name);
  } finally {
    connection.close();
  }
}

function addAgents(database: Database, names: string[]): void {
  const insert = database.prepare("INSERT INTO agents (name, created_at) VALUES (?, 1)");
  database.transaction(() => {
    for (const name of names) {
      insert.run(name);
    }
  });
}

function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("backupDatabase", () => {
  it("copies a database a server is writing to, consistently, in one step", async () => {
    const server = Database.open(source);
    try {
      // Enough pages that the copy takes long enough for writes to land
      // while it runs.
      addAgents(
        server,
        Array.from({ length: 20_000 }, (_, index) => `agent-${index}-${"x".repeat(40)}`),
      );
      let writing = true;
      let written = 0;
      const writes = (async () => {
        while (writing) {
          addAgents(server, [`during-${written++}`]);
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      const copy = path.join(backups, "copy.db");
      const result = await backupDatabase(source, copy);
      const writtenBy = written;
      writing = false;
      await writes;

      expect(writtenBy).toBeGreaterThan(0);
      expect(result).toEqual({
        file: copy,
        bytes: statSync(copy).size,
        schemaVersion: migrations.length,
      });
      // The copy is the database as it stood at one moment: every agent
      // before, and some prefix of those written meanwhile.
      const copied = agentsIn(copy);
      const during = copied.filter((name) => name.startsWith("during-"));
      expect(copied).toHaveLength(20_000 + during.length);
      expect(during).toEqual(
        Array.from({ length: during.length }, (_, index) => `during-${index}`),
      );
      expect(mode(copy)).toBe(0o600);
      expect(readdirSync(backups)).toEqual(["copy.db"]);
    } finally {
      server.close();
    }
  });

  it("leaves a database an earlier release wrote unmigrated", async () => {
    const raw = new DatabaseSync(source);
    raw.exec(`PRAGMA application_id = ${applicationId}`);
    raw.exec(migrations[0] ?? "");
    raw.exec("PRAGMA user_version = 1");
    raw.exec("INSERT INTO agents (name, created_at) VALUES ('builder', 1)");
    raw.close();
    chmodSync(source, 0o600);
    const before = readFileSync(source);

    const copy = path.join(backups, "copy.db");
    expect((await backupDatabase(source, copy)).schemaVersion).toBe(1);

    expect(readFileSync(source).equals(before)).toBe(true);
    expect(agentsIn(copy)).toEqual(["builder"]);
    const copied = new DatabaseSync(copy, { readOnly: true });
    expect(copied.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    copied.close();
  });

  it.each(["000", "022", "077"])(
    "creates the copy with mode 0600 under umask %s",
    async (umask) => {
      Database.open(source).close();
      const previous = process.umask(parseInt(umask, 8));
      try {
        await backupDatabase(source, path.join(backups, "copy.db"));
      } finally {
        process.umask(previous);
      }
      expect(mode(path.join(backups, "copy.db"))).toBe(0o600);
    },
  );

  it("refuses a destination that exists, and leaves it as it was", async () => {
    Database.open(source).close();
    const copy = path.join(backups, "copy.db");
    writeFileSync(copy, "an older backup", { mode: 0o600 });
    expect(await refusal(backupDatabase(source, copy))).toBeInstanceOf(BackupError);
    expect(readFileSync(copy, "utf8")).toBe("an older backup");
  });

  it("refuses a destination beside files SQLite would read into it", async () => {
    Database.open(source).close();
    const copy = path.join(backups, "copy.db");
    writeFileSync(`${copy}-journal`, "a stale journal", { mode: 0o600 });
    expect(await refusal(backupDatabase(source, copy))).toBeInstanceOf(BackupError);
    expect(readdirSync(backups)).toEqual(["copy.db-journal"]);
  });

  it.each(["-journal", "-wal", "-shm"])(
    "refuses a destination SQLite would take for the database's own %s, creating nothing",
    async (suffix) => {
      Database.open(source).close();
      const before = readdirSync(data);
      // Named through a symlink to the data directory too.
      const alias = path.join(root, "alias");
      symlinkSync(data, alias);
      for (const copy of [`${source}${suffix}`, path.join(alias, `agention.db${suffix}`)]) {
        expect(await refusal(backupDatabase(source, copy))).toBeInstanceOf(BackupError);
      }
      expect(readdirSync(data)).toEqual(before);
    },
  );

  it.each([
    ["others can read", 0o755],
    ["its group can write to", 0o770],
  ])("refuses a destination directory %s, creating nothing", async (_, open) => {
    Database.open(source).close();
    chmodSync(backups, open);
    expect(await refusal(backupDatabase(source, path.join(backups, "copy.db")))).toBeInstanceOf(
      BackupError,
    );
    expect(readdirSync(backups)).toEqual([]);
  });

  it("refuses a destination directory that does not exist, creating nothing", async () => {
    Database.open(source).close();
    const missing = path.join(root, "missing");
    expect(await refusal(backupDatabase(source, path.join(missing, "copy.db")))).toBeInstanceOf(
      BackupError,
    );
    expect(existsSync(missing)).toBe(false);
  });

  it("refuses a missing database, creating nothing", async () => {
    expect(await refusal(backupDatabase(source, path.join(backups, "copy.db")))).toBeInstanceOf(
      BackupError,
    );
    expect([readdirSync(data), readdirSync(backups)]).toEqual([[], []]);
  });

  it("refuses a file that is not an Agention database, leaving it as it was", async () => {
    const other = new DatabaseSync(source);
    other.exec("CREATE TABLE notes (text TEXT)");
    other.close();
    chmodSync(source, 0o600);
    const before = readFileSync(source);
    const error = await refusal(backupDatabase(source, path.join(backups, "copy.db")));
    expect(error).toBeInstanceOf(DatabaseOpenError);
    expect((error as DatabaseOpenError).reason).toBe("not_agention");
    expect(readFileSync(source).equals(before)).toBe(true);
    expect(readdirSync(backups)).toEqual([]);
  });

  it("leaves no file behind when the copy fails its check", async () => {
    const server = Database.open(source);
    addAgents(
      server,
      Array.from({ length: 2_000 }, (_, index) => `agent-${index}`),
    );
    server.close();
    // Damage a page of the agents table past the schema's.
    const fd = openSync(source, "r+");
    writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, 4096 * 8);
    closeSync(fd);

    expect(await refusal(backupDatabase(source, path.join(backups, "copy.db")))).toBeInstanceOf(
      BackupError,
    );
    expect(readdirSync(backups)).toEqual([]);
  });
});

describe("a restore from a copy", () => {
  it("is the copy, even where the database it replaced left a log behind", async () => {
    const server = Database.open(source);
    addAgents(server, ["before"]);
    const copy = path.join(backups, "copy.db");
    await backupDatabase(source, copy);
    addAgents(server, ["after"]);
    // A server killed now would leave its log, holding "after", beside the
    // database.
    copyFileSync(`${source}-wal`, path.join(root, "stale-wal"));
    server.close();
    copyFileSync(path.join(root, "stale-wal"), `${source}-wal`);
    chmodSync(`${source}-wal`, 0o600);

    // Restoring: the database and its files move aside, and the copy comes
    // in as the database.
    const aside = path.join(root, "replaced");
    mkdirSync(aside, { mode: 0o700 });
    for (const file of readdirSync(data)) {
      renameSync(path.join(data, file), path.join(aside, file));
    }
    copyFileSync(copy, source);
    chmodSync(source, 0o600);

    const restored = Database.open(source);
    try {
      const names = restored.prepare("SELECT name FROM agents ORDER BY id").all();
      expect(names).toEqual([{ name: "before" }]);
    } finally {
      restored.close();
    }
  });
});
