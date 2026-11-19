import { singleLineText } from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";

// A server's name: the web UI's title and the brand in its banner, and what a
// passkey made on the server carries, so an operator running several servers
// tells them apart. The first agention serve on a database to listen stores
// it, Agention unless given another, in the instance row; it never changes
// after, which the database enforces.

// What a server's name may be: one line of 1 to 40 characters.
export const serverName = singleLineText({ min: 1, max: 40 });

// storedName reads the server's name, undefined until the first start to
// listen stores it.
export function storedName(db: Database): string | undefined {
  const { name } = db.prepare("SELECT name FROM instance WHERE id = 1").get() as {
    name: string | null;
  };
  return name === null ? undefined : checked(name);
}

// storeName stores name as the server's unless a name is stored already, and
// returns the stored one: name itself, or the name a start racing this one
// stored first.
export function storeName(db: Database, name: string): string {
  return db.transaction(() => {
    const row = db
      .prepare("UPDATE instance SET name = coalesce(name, ?) WHERE id = 1 RETURNING name")
      .get(name) as { name: string };
    return checked(row.name);
  });
}

// The instance row is persisted state, so a name read from it is checked.
function checked(name: string): string {
  if (!serverName.safeParse(name).success) {
    throw new Error("the stored server name is malformed");
  }
  return name;
}
