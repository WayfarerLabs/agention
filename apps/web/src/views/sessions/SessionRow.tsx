import type {
  MonitorReason,
  SessionLog as SessionLogAnswer,
  SessionLogMark,
  SessionSummary,
  SessionUpdate,
} from "@wayfarerlabs/agention-api";
import {
  type MouseEvent,
  type ReactNode,
  type Ref,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { query, request, sessionPath } from "../../api.ts";
import { Loadable, MenuItem, OptionsMenu } from "../../components.tsx";
import { useFresh, useReading, useResource } from "../../data.ts";
import {
  conditionWords,
  nudgeNeedsYou,
  nudgeWords,
  type Observed,
  observedOf,
  plural,
  Since,
  Spoken,
  Time,
  terminalNeedsYou,
  unableNeedsYou,
  unableReasonWords,
  workStateWords,
} from "../../format.tsx";
import { Icon, Mark } from "../../icons.tsx";
import { BlockedLink, FilterLink, UnreadLink } from "../filter-links.tsx";
import { sessionNeedsYou } from "./arrangement.ts";
import { type Change, type LogLine, logLines } from "./log.ts";
import { GroupChip, TagChip } from "./GroupsAndTags.tsx";
import { NeedsYouFlag, type ViewShown } from "./needs-you.tsx";
import { AgentReadLink, OpenAsksLink, rollupOfSession, ThreadsLink } from "./roll-ups.tsx";
import { type Credential, Revocation } from "./Registrations.tsx";

// One session in the sessions view: a folded row of three short lines, its
// head; where it is, as the server knows it, apart from what its agent
// reports: whether its bridge is connected and what its terminal shows, when
// its agent last checked in and when it last updated its status; and its key
// facts, the facts wrapping on a phone, so that many fit on a screen;
// unfolded, its title wrapping whole in its head, and beneath, its goal, its
// credentials, how its terminal is monitored and its log. The row's chevron
// folds or unfolds it, as a tap anywhere else on the row does, but for the
// links and the controls on it: the session's name and every fact that
// stands for threads link to them on the thread list. A row's log loads,
// refreshes and is read only while the row is unfolded and shown.

// A session's path, by which the view names it.
export const sessionKey = (agent: string, session: string) => `${agent}/${session}`;

export function SessionRow({
  level,
  agent,
  session,
  shown,
  unfolded,
  toggle,
  refresh,
  newThread,
  organize,
  alone = false,
}: {
  // The level of the row's heading, one below its agent's, or the agents'
  // own when it stands alone.
  level: 3 | 4 | 5;
  agent: string;
  session: SessionSummary;
  // The view on screen, which the row's Needs you flag filters.
  shown: ViewShown;
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
  // Whether it stands alone, with no agent's header above it, so it names
  // its agent too.
  alone?: boolean;
}) {
  const detail = useId();
  const fold = useId();
  const options = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [revoking, setRevoking] = useState<Credential>();
  const path = sessionKey(agent, session.session);
  const { status } = session;
  const Heading = `h${level}` as const;
  return (
    <li className={unfolded ? "session-row unfolded" : "session-row"}>
      <div className="session-summary">
        <div className="session-head">
          {/* The heading goes by its fold's name alone, as a Fold's does, so
              the linked name beside it does not say it twice. The spaces
              between the parts keep them apart as they are read; the layout
              sets them apart for the eye. */}
          <Heading aria-labelledby={fold}>
            <button
              type="button"
              id={fold}
              className="session-fold"
              aria-expanded={unfolded}
              aria-controls={unfolded ? detail : undefined}
              aria-label={`Session ${alone ? path : session.session}`}
              onClick={toggle}
            >
              <Icon name="expand" />
            </button>{" "}
            <FilterLink
              className="session-name"
              narrowing={{ session: [path] }}
              spoken={`Threads of session ${path}`}
            >
              {alone ? path : session.session}
            </FilterLink>{" "}
            {status?.title !== undefined && <span className="session-title">{status.title}</span>}{" "}
            {status?.percent !== undefined && (
              <span className="session-percent">{status.percent}%</span>
            )}
          </Heading>
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
        <PresenceLine session={session} />
        <SessionFacts agent={agent} session={session} shown={shown} />
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

// PresenceLine is the line under a session's head saying where the session
// is, as the server knows it, apart from what its agent reports: whether its
// bridge is connected, which a bridge from before monitoring never says;
// while it is, what its terminal shows and since when, where the bridge
// monitors it; why it cannot be monitored or nudged, with since when, where
// that is trouble rather than how the session was set up (no tmux socket or
// the nudge off, which its unfolded detail says); what came of its latest
// nudge, once its bridge tried one, with the attempt's id, which the
// harness's transcript shows too; when its agent last checked in, or that it
// never did; and how long ago its status was last updated, once it has one,
// since an agent can keep checking in long after its status stopped saying
// what it does, as in "Connected, at its prompt since 14:02 · nudged 14:05
// (3f9a0c1d2e4b) · last check-in 14:05 · status updated 3 hours ago". What
// needs the operator takes the warning's tone: a bridge not connected and a
// check-in long enough ago to be quiet, unless the session has stopped,
// which its state says already; a terminal showing a prompt or something
// that stopped it; nudge text left at the prompt; and a nudge that failed,
// or was sent with no check-in since. One stopped at the terminal reads
// neutral, as the choice of whoever was there.
function PresenceLine({ session }: { session: SessionSummary }) {
  const { presence, status } = session;
  const stopped = status?.state === "stopped";
  const observed = observedOf(presence);
  const parts: ReactNode[] = [];
  if (presence.connected === true) {
    parts.push(
      <span className="session-connection">
        Connected
        {observed !== undefined && (
          <>
            , <Condition observed={observed} />
          </>
        )}
      </span>,
    );
  } else if (presence.connected === false) {
    parts.push(
      <span className={stopped ? "session-connection" : "session-connection warning"}>
        Not connected
      </span>,
    );
  }
  const unable = presence.connected === true ? presence.monitor?.unable : undefined;
  if (unable !== undefined && !setUp.has(unable.reason)) {
    parts.push(<Unable unable={unable} />);
  }
  const nudge = presence.last_nudge;
  if (nudge !== undefined) {
    const words = nudgeWords(nudge);
    parts.push(
      <span className={nudgeNeedsYou(nudge) ? "session-nudge warning" : "session-nudge"}>
        {parts.length > 0 ? words : `${words.charAt(0).toUpperCase()}${words.slice(1)}`} (
        <span className="code small">{nudge.id}</span>)
      </span>,
    );
  }
  const quiet = presence.quiet && !stopped;
  const never = presence.last_seen_at === undefined;
  const words = never ? "never checked in" : "last check-in";
  // The line's first part starts it, as a sentence starts.
  const checkIn = parts.length > 0 ? words : never ? "Never checked in" : "Last check-in";
  parts.push(
    <span className={quiet ? "session-check-in warning" : "session-check-in"}>
      {quiet ? <Spoken shown={checkIn} spoken={`Quiet, ${words}`} /> : checkIn}
      {presence.last_seen_at !== undefined && (
        <>
          {" "}
          <Since value={presence.last_seen_at} />
        </>
      )}
    </span>,
  );
  if (status !== undefined) {
    parts.push(
      <span className="session-status-age">
        status updated <Time value={status.updated_at} />
      </span>,
    );
  }
  return (
    <p className="session-seen">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && " · "}
          {part}
        </span>
      ))}
    </p>
  );
}

// The reasons a session cannot be monitored or nudged that say how it was set
// up, which its line leaves to its unfolded detail.
const setUp: ReadonlySet<string> = new Set(["no_socket", "nudge_off"]);

// Unable says why a session's bridge cannot monitor or nudge, and since when,
// as in "Can't be nudged: nudge text left at the prompt since 14:05", in the
// warning's tone where that needs the operator.
function Unable({ unable }: { unable: { reason: MonitorReason; since: string } }) {
  return (
    <span className={unableNeedsYou(unable.reason) ? "session-unable warning" : "session-unable"}>
      {unableReasonWords(unable.reason)} since <Since value={unable.since} />
    </span>
  );
}

// Condition says what a session's terminal shows and since when, as in "at
// its prompt since 14:02", in the warning's tone when it needs the operator.
function Condition({ observed }: { observed: Observed }) {
  return (
    <span className="session-condition">
      <span className={terminalNeedsYou(observed) ? "warning" : undefined}>
        {conditionWords(observed)}
      </span>{" "}
      since <Since value={observed.since} />
    </span>
  );
}

// The session's facts on its folded row: what it is doing, as it reports;
// Needs you while its terminal shows a prompt or something that stopped it,
// linking to the view's filter on such sessions; Blocked on you while any
// open ask blocks its work, linking to its blocked threads, and its open
// asks, linking to its open threads; whether it has no credential; the
// operator's group and tags for it, each linking to its threads; its
// threads' roll-up, linking to them, and how many are stranded and how many
// ignored, each linking to those, but for blocked, which leads its open asks
// already, and the envelope, linking to its unread threads; its unread
// updates; and its latest note, cut to fit, which its log holds whole.
function SessionFacts({
  agent,
  session,
  shown,
}: {
  agent: string;
  session: SessionSummary;
  shown: ViewShown;
}) {
  const { status, open_asks: asks, threads } = session;
  const path = sessionKey(agent, session.session);
  const rollup = rollupOfSession(session);
  const scope = { narrowing: { session: [path] }, label: path };
  return (
    <ul className="tags session-facts">
      <li className={status === undefined ? "muted" : stateTone[status.state]}>
        {status === undefined ? "No status" : workStateWords(status)}
      </li>
      {sessionNeedsYou(session) && (
        <li className="bare">
          <NeedsYouFlag path={path} shown={shown} />
        </li>
      )}
      {asks.blocking_count > 0 && (
        <li className="bare">
          <BlockedLink {...scope} />
        </li>
      )}
      {asks.count > 0 && (
        <li className="bare">
          <OpenAsksLink count={asks.count} {...scope} />
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
      <li className="bare">
        <ThreadsLink rollup={rollup} {...scope} />
      </li>
      {threads.stranded > 0 && (
        <li className="bare">
          <AgentReadLink read="stranded" count={threads.stranded} {...scope} />
        </li>
      )}
      {threads.ignored > 0 && (
        <li className="bare">
          <AgentReadLink read="ignored" count={threads.ignored} {...scope} />
        </li>
      )}
      <li className="bare">
        <UnreadLink unread={rollup.unread} {...scope} />
      </li>
      {rollup.unread_updates > 0 && (
        <li className="accent">{plural(rollup.unread_updates, "new update")}</li>
      )}
      {status?.note !== undefined && <li className="bare session-note">{status.note}</li>}
    </ul>
  );
}

// The tone of each state's chip.
const stateTone = { working: "success", idle: "accent", stopped: undefined } as const;

// SessionDetail is what a session unfolds beneath its head: its goal whole,
// with how far it has come, its credentials, how its connected bridge
// monitors its terminal and whether it can nudge the agent there, or why it
// cannot monitor or nudge and since when, once it has said, and its log.
function SessionDetail({
  agent,
  session,
  refresh,
}: {
  agent: string;
  session: SessionSummary;
  refresh: () => void;
}) {
  const { status } = session;
  const goal = status?.goal;
  const percent = status?.percent;
  const codes = session.registrations.map((registration) => registration.code);
  const { monitor } = session.presence;
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
        {monitor !== undefined && (
          <li>
            {monitor.monitored ? (
              <>
                Terminal read with the <span className="code small">{monitor.profile}</span> profile
              </>
            ) : (
              "Terminal not monitored"
            )}
          </li>
        )}
        {monitor?.unable !== undefined ? (
          <li className="session-can-nudge">
            <Unable unable={monitor.unable} />
          </li>
        ) : (
          monitor?.monitored === true && (
            <li className="session-can-nudge">
              {monitor.nudge ? "Can be nudged" : "Cannot be nudged"}
            </li>
          )
        )}
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
async function loadLog(
  agent: string,
  session: string,
  wanted: number,
  signal: AbortSignal,
): Promise<LoadedLog> {
  const entries: SessionUpdate[] = [];
  let readThrough: number | undefined;
  let before: number | undefined;
  while (entries.length <= wanted) {
    const limit = Math.min(100, wanted + 1 - entries.length);
    const page = await request<SessionLogAnswer>(
      "GET",
      sessionPath(agent, session, `/updates${query({ before, limit })}`),
      { signal },
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
  const log = useResource((signal) => loadLog(agent, session, wanted.current, signal));
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
  useLayoutEffect(() => {
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
// what its entries changed, with the note, or, for an entry the server
// inferred, that it did, marked while it was unread when shown. It takes
// focus only from script, as when Older goes.
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
  if (newest.inferred) {
    parts.push(<span className="muted log-inferred">inferred from a write</span>);
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
