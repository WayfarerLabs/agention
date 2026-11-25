import {
  type BranchLink,
  type BranchRollup,
  linkKey,
  maxListed,
  type PullRequestLink,
  type PullRequestRollup,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";

// The pull requests and branches a message names: writing them with it,
// reading them back with it, and rolling them up for its thread.

// A message's lists, as its write carries them.
export interface MessageLinks {
  pull_requests?: PullRequestLink[] | undefined;
  branches?: BranchLink[] | undefined;
}

type Kind = "pull_request" | "branch";

// A row of message_links, whose check holds a pull request's number and a
// branch's name.
type LinkRow = { seq: number; repo: string; url: string | null } & (
  | { kind: "pull_request"; number: number; branch: null }
  | { kind: "branch"; number: null; branch: string }
);
type PullRequestRow = Extract<LinkRow, { kind: "pull_request" }>;
type BranchRow = Extract<LinkRow, { kind: "branch" }>;

// insertLinks writes a message's lists, each in the order it gave them. The
// message's schema has already refused a list naming an entry twice.
export function insertLinks(db: Database, threadId: number, seq: number, links: MessageLinks) {
  const insert = db.prepare(
    `INSERT INTO message_links (thread_id, seq, kind, position, link_key, repo, number, branch,
       url)
     VALUES (:thread_id, :seq, :kind, :position, :link_key, :repo, :number, :branch, :url)`,
  );
  const write = (kind: Kind, list: (PullRequestLink | BranchLink)[] | undefined) => {
    list?.forEach((link, position) => {
      insert.run({
        thread_id: threadId,
        seq,
        kind,
        position,
        link_key: linkKey(link),
        repo: link.repo,
        number: "number" in link ? link.number : null,
        branch: "branch" in link ? link.branch : null,
        url: link.url ?? null,
      });
    });
  };
  write("pull_request", links.pull_requests);
  write("branch", links.branches);
}

function pullRequestOf(row: PullRequestRow): PullRequestLink {
  return {
    repo: row.repo,
    number: row.number,
    ...(row.url === null ? {} : { url: row.url }),
  };
}

function branchOf(row: BranchRow): BranchLink {
  return {
    repo: row.repo,
    branch: row.branch,
    ...(row.url === null ? {} : { url: row.url }),
  };
}

// readLinks reads the lists of a thread's messages after one sequence through
// another, by message, each list in the order its message gave it.
export function readLinks(
  db: Database,
  span: { thread: number; after: number; last: number },
): Map<number, MessageLinks> {
  const rows = db
    .prepare(
      `SELECT seq, kind, repo, number, branch, url FROM message_links
       WHERE thread_id = :thread AND seq > :after AND seq <= :last
       ORDER BY seq, kind, position`,
    )
    .all(span) as unknown as LinkRow[];
  const bySeq = new Map<number, MessageLinks>();
  for (const row of rows) {
    const links = bySeq.get(row.seq) ?? {};
    if (row.kind === "pull_request") {
      (links.pull_requests ??= []).push(pullRequestOf(row));
    } else {
      (links.branches ??= []).push(branchOf(row));
    }
    bySeq.set(row.seq, links);
  }
  return bySeq;
}

// rolledUp lists one kind of a thread's entries: each key its live messages
// name, once, as its latest live mention wrote it, with the URL of the latest
// live mention that gave one, the most recently mentioned first and, within
// one message, in its order. A message names a key once, so its sequence
// orders the mentions of a key. One row past maxListed says some were left
// out.
function rolledUp<K extends Kind>(db: Database, threadId: number, kind: K) {
  const rows = db
    .prepare(
      `WITH mentions AS (
         SELECT k.seq, k.position, k.repo, k.number, k.branch,
           row_number() OVER (PARTITION BY k.link_key ORDER BY k.seq DESC) AS newest,
           first_value(k.url) OVER (
             PARTITION BY k.link_key ORDER BY k.url IS NULL, k.seq DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
           ) AS url
         FROM message_links k
         JOIN live_messages l ON l.thread_id = k.thread_id AND l.seq = k.seq
         WHERE k.thread_id = :thread AND k.kind = :kind
       )
       SELECT seq, :kind AS kind, repo, number, branch, url FROM mentions
       WHERE newest = 1
       ORDER BY seq DESC, position
       LIMIT :limit`,
    )
    .all({ thread: threadId, kind, limit: maxListed + 1 }) as unknown as Extract<
    LinkRow,
    { kind: K }
  >[];
  return { rows: rows.slice(0, maxListed), truncated: rows.length > maxListed };
}

// threadLinks rolls up the pull requests and branches a thread's live
// messages name; a replaced message's lists play no part.
export function threadLinks(
  db: Database,
  threadId: number,
): { pull_requests: PullRequestRollup; branches: BranchRollup } {
  const pulls = rolledUp(db, threadId, "pull_request");
  const branches = rolledUp(db, threadId, "branch");
  return {
    pull_requests: { links: pulls.rows.map(pullRequestOf), truncated: pulls.truncated },
    branches: { links: branches.rows.map(branchOf), truncated: branches.truncated },
  };
}
