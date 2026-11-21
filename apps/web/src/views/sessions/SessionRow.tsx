import type {
  SessionLog as SessionLogAnswer,
  SessionLogMark,
  SessionSummary,
  SessionUpdate,
} from "@wayfarerlabs/agention-api";
import { type MouseEvent, type Ref, useEffect, useId, useMemo, useRef, useState } from "react";
import { query, request, sessionPath } from "../../api.ts";
import { Loadable, MenuItem, OptionsMenu } from "../../components.tsx";
import { useFresh, useReading, useResource } from "../../data.ts";
import { plural, Since, Spoken, workStateWords } from "../../format.tsx";
import { Icon, Mark } from "../../icons.tsx";
import { Link, listHref, unfiltered } from "../../router.tsx";
import { type Change, type LogLine, logLines } from "./log.ts";
import { GroupChip, TagChip } from "./GroupsAndTags.tsx";
import { type Credential, Revocation } from "./Registrations.tsx";

// One session in the sessions view: a folded row of two lines, wrapping to
// three on a phone, that carries its key facts, so that many fit on a screen;
// unfolded, its title wrapping whole in its head, and beneath, its goal, when
// it was last seen, its credentials and its log. Tapping anywhere on the row's facts folds or unfolds it, but
// for the links and the options among them. A row's log loads, refreshes and
// is read only while the row is unfolded and shown.

// A session's path, by which the view names it.
export const sessionKey = (agent: string, session: string) => `${agent}/${session}`;

export function SessionRow({
  agent,
  session,
  unfolded,
  toggle,
  refresh,
  newThread,
  organize,
}: {
  agent: string;
  session: SessionSummary;
  unfolded: boolean;
  toggle: () => void;
  // Reloads the view, after something here changed it.
  refresh: () => void;
  // Opens the new-thread sheet on the session, focus returning to the
  // control given when it closes.
  newThread: (opener: HTMLElement | null) => void;
  // Opens the sheet that sets the session's group or its tags, focus
  // returning to the control given when it closes.
  organize: (what: "group" | "tags", opener: HTMLElement | null) => void;
}) {
  const detail = useId();
  const options = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [revoking, setRevoking] = useState<Credential>();
  const path = sessionKey(agent, session.session);
  const { status } = session;
  return (
    <li className="session-row">
      <div className="session-summary">
        <div className="session-head">
          <h4>
            <button
              type="button"
              className="session-fold"
              aria-expanded={unfolded}
              aria-controls={unfolded ? detail : undefined}
              onClick={toggle}
            >
              <Icon name="expand" />
              {/* The spaces between the parts keep them apart in the
                  button's name; the layout sets them apart for the eye. */}
              <span className="session-name">{session.session}</span>{" "}
              {status?.title !== undefined && <span className="session-title">{status.title}</span>}{" "}
              {status?.percent !== undefined && (
                <span className="session-percent">{status.percent}%</span>
              )}
            </button>
          </h4>
          <OptionsMenu label={`Options for ${path}`} open={menu} setOpen={setMenu} button={options}>
            <MenuItem onChoose={() => newThread(options.current)}>New thread</MenuItem>
            <MenuItem onChoose={() => organize("group", options.current)}>
              Group: {session.group?.name ?? "none"}
            </MenuItem>
            <MenuItem onChoose={() => organize("tags", options.current)}>
              Tags: {session.tags.length === 0 ? "none" : session.tags.join(", ")}
            </MenuItem>
            {session.registrations.map((registration) => (
              <MenuItem
                key={registration.id}
                className="destructive"
                onChoose={() => setRevoking({ ...registration, session: path })}
              >
                Revoke <span className="code small">{registration.code}</span>
              </MenuItem>
            ))}
          </OptionsMenu>
        </div>
        <SessionFacts agent={agent} session={session} />
      </div>
      <Revocation
        asking={revoking}
        stop={() => setRevoking(undefined)}
        opener={options}
        onRevoked={refresh}
      />
      {unfolded && (
        <div id={detail} className="session-detail">
          <SessionDetail agent={agent} session={session} refresh={refresh} />
        </div>
      )}
    </li>
  );
}

// The session's facts on its folded row: what it is doing; what waits on the
// operator, its open asks, linking to its open threads; whether it is quiet
// or has no credential; the operator's group and tags for it; its unread
// updates; its threads, with how many are stranded, linking to them; and its
// latest note, cut to fit, which its log holds whole.
function SessionFacts({ agent, session }: { agent: string; session: SessionSummary }) {
  const { status, presence, open_asks: asks, threads } = session;
  const path = sessionKey(agent, session.session);
  const stopped = status?.state === "stopped";
  return (
    <ul className="tags session-facts">
      <li className={status === undefined ? "muted" : stateTone[status.state]}>
        {status === undefined ? "No status" : workStateWords(status)}
      </li>
      {asks.count > 0 && (
        <li className="bare">
          <Link to={listHref({ ...unfiltered, session: [path], status: "open" })}>
            <span className="pill attention">
              Waiting on you · {plural(asks.count, "ask")}
              {asks.blocking_count > 0 && `, ${asks.blocking_count} blocking`}
            </span>
          </Link>
        </li>
      )}
      {presence.quiet && !stopped && (
        <li className="warning">
          {presence.last_seen_at === undefined ? (
            "Quiet, never seen"
          ) : (
            <>
              Quiet since <Since value={presence.last_seen_at} />
            </>
          )}
        </li>
      )}
      {session.registrations.length === 0 && <li className="warning">No credential</li>}
      {session.group !== undefined && (
        <li className="bare">
          <GroupChip group={session.group} />
        </li>
      )}
      {session.tags.map((tag) => (
        <li key={tag} className="bare">
          <TagChip tag={tag} />
        </li>
      ))}
      {session.unread_updates > 0 && (
        <li className="bare">
          <Mark
            icon="unread"
            label={plural(session.unread_updates, "unread update")}
            shown={session.unread_updates}
            accent
          />
        </li>
      )}
      <li className="bare">
        <Link to={listHref({ ...unfiltered, session: [path] })}>
          {plural(threads.total, "thread")}
        </Link>
        {threads.stranded > 0 && <span className="stranded"> · {threads.stranded} stranded</span>}
      </li>
      {status?.note !== undefined && <li className="bare session-note">{status.note}</li>}
    </ul>
  );
}

// The tone of each state's chip.
const stateTone = { working: "success", idle: "accent", stopped: undefined } as const;

// SessionDetail is what a session unfolds beneath its head: its goal whole,
// with how far it has come, when it was last seen, its credentials, and its log.
function SessionDetail({
  agent,
  session,
  refresh,
}: {
  agent: string;
  session: SessionSummary;
  refresh: () => void;
}) {
  const { status, presence } = session;
  const goal = status?.goal;
  const percent = status?.percent;
  const codes = session.registrations.map((registration) => registration.code);
  return (
    <>
      {(goal !== undefined || percent !== undefined) && (
        <div className="session-goal">
          <p>
            {goal === undefined ? "No goal given" : <>Goal: {goal}</>}
            {percent !== undefined && <span className="session-percent"> {percent}%</span>}
          </p>
          {percent !== undefined && (
            <progress max={100} value={percent} aria-label="Toward the goal">
              {percent}%
            </progress>
          )}
        </div>
      )}
      <ul className="session-about">
        <li>
          {presence.last_seen_at === undefined ? (
            "Never seen"
          ) : (
            <>
              Last seen <Since value={presence.last_seen_at} at />
            </>
          )}
        </li>
        <li>
          {codes.length === 0 ? (
            "No active credential"
          ) : (
            <>
              {codes.length === 1 ? "Credential" : "Credentials"}{" "}
              {codes.map((code, index) => (
                <span key={code}>
                  {index > 0 && ", "}
                  <span className="code small">{code}</span>
                </span>
              ))}
            </>
          )}
        </li>
      </ul>
      {status === undefined ? (
        <p className="muted">
          This session has not reported its status. Its agent's bridge may predate session status.
        </p>
      ) : (
        <SessionLog agent={agent} session={session.session} onRead={refresh} />
      )}
    </>
  );
}

// How many more of the log's entries Older shows each time.
const logPage = 10;

// The log as the view loads it: as many entries as were wanted, newest
// first, and the one before the oldest of them, if any, by which what that
// one changed is read; how far the operator has read the log; and how many
// entries were wanted.
interface LoadedLog {
  shown: SessionUpdate[];
  earlier: SessionUpdate | undefined;
  read_through: number;
  wanted: number;
}

// loadLog reads the newest entries of a session's log, as many as wanted and
// one more, a page at a time.
async function loadLog(agent: string, session: string, wanted: number): Promise<LoadedLog> {
  const entries: SessionUpdate[] = [];
  let readThrough: number | undefined;
  let before: number | undefined;
  while (entries.length <= wanted) {
    const limit = Math.min(100, wanted + 1 - entries.length);
    const page = await request<SessionLogAnswer>(
      "GET",
      sessionPath(agent, session, `/updates${query({ before, limit })}`),
    );
    readThrough ??= page.read_through;
    entries.push(...page.updates);
    before = page.updates.at(-1)?.seq;
    if (page.updates.length < limit || before === undefined || before <= 1) {
      break;
    }
  }
  return {
    shown: entries.slice(0, wanted),
    earlier: entries[wanted],
    read_through: readThrough ?? 0,
    wanted,
  };
}

// SessionLog is a session's log, newest first: each line what its entries
// changed, consecutive progress-only entries collapsed into one, and Older
// for the entries before. It refreshes as the view does, and each refresh
// reloads every entry shown, as many pages as Older has asked for. Showing
// the log reads it, as the thread page reads what it shows, and the entries
// that were unread when shown stay marked until the row folds.
function SessionLog({
  agent,
  session,
  onRead,
}: {
  agent: string;
  session: string;
  onRead: () => void;
}) {
  const wanted = useRef(logPage);
  const [asked, setAsked] = useState(logPage);
  const log = useResource(() => loadLog(agent, session, wanted.current));
  const { data, refresh } = log;
  const reading = useReading(
    useMemo(
      () =>
        data === undefined
          ? undefined
          : { through: data.shown[0]?.seq ?? 0, read: data.read_through },
      [data],
    ),
    (through, csrf) =>
      request<SessionLogMark>("POST", sessionPath(agent, session, "/updates/read"), {
        csrf,
        body: { through },
      }),
    onRead,
  );
  const fresh = useFresh(
    useMemo(
      () => data?.shown.filter((entry) => entry.seq > data.read_through).map((entry) => entry.seq),
      [data],
    ),
  );
  // While the entries the operator asked for with Older load, Older says so
  // and takes no more presses, staying in the tab order so focus stays on it,
  // which the refreshes in between leave alone. Once the first entry shows,
  // Older goes, and focus that was on it moves to the oldest entry.
  const loadingOlder = log.loading && (data?.wanted ?? 0) < asked;
  const more = (data?.shown.at(-1)?.seq ?? 1) > 1;
  const oldest = useRef<HTMLLIElement>(null);
  const focusOldest = useRef(false);
  useEffect(() => {
    if (focusOldest.current && !loadingOlder && !more) {
      focusOldest.current = false;
      oldest.current?.focus();
    }
  }, [loadingOlder, more]);
  const older = (event: MouseEvent<HTMLButtonElement>) => {
    if (loadingOlder) {
      return;
    }
    focusOldest.current = document.activeElement === event.currentTarget;
    wanted.current += logPage;
    setAsked(wanted.current);
    refresh();
  };
  return (
    <Loadable data={data} failure={log.failure} retry={refresh}>
      {({ shown, earlier }) => {
        const lines = logLines(shown, earlier);
        return (
          <>
            <ol className="session-log" aria-label="Updates">
              {lines.map((line, index) => (
                <LogEntry
                  key={line.entries[0]?.seq}
                  ref={index === lines.length - 1 ? oldest : undefined}
                  line={line}
                  unread={line.entries.some((entry) => fresh.has(entry.seq))}
                />
              ))}
            </ol>
            {more && (
              <button
                type="button"
                className="quiet older"
                aria-disabled={loadingOlder ? true : undefined}
                onClick={older}
              >
                Older
              </button>
            )}
            {reading.failure !== undefined && (
              <div className="notice danger" role="alert">
                <p>Marking these updates read failed. The next refresh tries again.</p>
              </div>
            )}
          </>
        );
      }}
    </Loadable>
  );
}

// LogEntry is one line of the log: when its newest entry was written, and
// what its entries changed, with the note, marked while it was unread when
// shown. It takes focus only from script, as when Older goes.
function LogEntry({
  line,
  unread,
  ref,
}: {
  line: LogLine;
  unread: boolean;
  ref?: Ref<HTMLLIElement> | undefined;
}) {
  const newest = line.entries[0] as SessionUpdate;
  const parts = line.changes.map((change) => <ChangeWords change={change} />);
  if (line.entries.length > 1) {
    parts.push(<span className="muted">{plural(line.entries.length, "update")}</span>);
  }
  if (line.note !== undefined) {
    parts.push(<q>{line.note}</q>);
  }
  return (
    <li ref={ref} tabIndex={-1} className={unread ? "unread" : undefined}>
      <Since value={newest.created_at} />
      <span className="log-what">
        {unread && <Mark icon="unread" label="Unread" accent />}
        {parts.map((part, index) => (
          <span key={index}>
            {index > 0 && " · "}
            {part}
          </span>
        ))}
      </span>
    </li>
  );
}

// An arrow from a value to the one that took its place, said as "to".
const to = <Spoken shown=" → " spoken=" to " />;

// ChangeWords says what an entry changed: "Idle → Working", "Title “…”",
// "Goal “…”" or "Progress 20% → 60%".
function ChangeWords({ change }: { change: Change }) {
  switch (change.kind) {
    case "state":
      return change.from === undefined ? (
        <strong>{workStateWords(change.to)}</strong>
      ) : (
        <>
          {workStateWords(change.from)}
          {to}
          <strong>{workStateWords(change.to)}</strong>
        </>
      );
    case "title":
      return (
        <>
          Title <q>{change.title}</q>
        </>
      );
    case "goal":
      return (
        <>
          Goal <q>{change.goal}</q>
        </>
      );
    case "percent":
      return change.from === undefined ? (
        <>Progress {change.to}%</>
      ) : (
        <>
          Progress {change.from}%{to}
          {change.to}%
        </>
      );
  }
}
