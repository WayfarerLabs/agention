import type { Registration, SessionSummary } from "@wayfarerlabs/agention-api";
import { createContext, type ReactNode, useContext, useId, useRef, useState } from "react";
import type { Agents } from "../../api.ts";
import { MenuItem, OptionsMenu, PageHeading } from "../../components.tsx";
import { plural, Since, Spoken, Time, workStateWords } from "../../format.tsx";
import { Icon } from "../../icons.tsx";
import { Link, registrationHref, sessionHref } from "../../router.tsx";
import { BlockedLink, FilterLink, UnreadLink } from "../filter-links.tsx";
import { ListBeside, landFrom } from "../side-by-side.tsx";
import { useArranged } from "./arrangement.ts";
import { GroupChip, TagChip } from "./GroupsAndTags.tsx";
import { type Credential, proposalOf, proposalWords, Revocation } from "./Registrations.tsx";
import { OpenAsksLink, rollupOfSession, StrandedLink, ThreadsLink } from "./roll-ups.tsx";
import { SessionDetail } from "./SessionDetail.tsx";

// One session in the sessions view, or one registration waiting for
// approval (RegistrationRow). In the rows a session is a row of three short
// lines, its head, when it was last seen and its status updated, and its key
// facts, the facts wrapping on a phone, so that many fit on a screen: the
// session's name and every fact that stands for threads link to them on the
// thread list. The row's chevron is a link to the session's address, as is
// a tap anywhere else on the row, but for the links and the controls on it:
// side by side (side-by-side.tsx) the session shows whole in the pane beside
// the rows (SessionOpen), its row marked while it does, and one pane at a
// time, as on a phone, on a page of its own, as a thread does.

// A session's path, by which the view names it.
export const sessionKey = (agent: string, session: string) => `${agent}/${session}`;

// findSession gives a session among the agents the view lists, by its agent
// and its name, if it is among them.
export const findSession = (
  agents: Agents | undefined,
  agent: string,
  session: string,
): SessionSummary | undefined =>
  agents?.find((entry) => entry.agent === agent)?.sessions.find((each) => each.session === session);

// What a session's options act through: reloading the view after something
// here changed it; opening the new-thread sheet on the session; and opening
// the sheet that sets its group or its tags. Focus returns to the control
// given when a sheet closes.
interface SessionActions {
  refresh: () => void;
  newThread: (opener: HTMLElement | null) => void;
  organize: (what: "group" | "tags", opener: HTMLElement | null) => void;
}

// The registrations waiting for approval, as the sessions view holds them,
// for a session's facts to lead to those waiting to be approved onto it
// (WaitingLinks).
export const WaitingRegistrations = createContext<readonly Registration[]>([]);

// RowLead is a row's chevron, the link to what the row stands for, at href,
// stretched under the whole row, named by name. The arrangement the rows are
// in goes with the address, as it goes with the rows' own; side by side,
// the row of what is open beside the rows is current, and opening it again
// lands in its pane.
function RowLead({ id, href, name }: { id: string; href: string; name: string }) {
  const link = useRef<HTMLAnchorElement>(null);
  const beside = useContext(ListBeside);
  const arranged = useArranged();
  const current = beside?.open === href;
  return (
    <Link
      ref={link}
      id={id}
      className="session-lead"
      to={`${href}${arranged}`}
      {...(current ? { follow: () => landFrom(link.current) } : {})}
      aria-current={current ? "page" : undefined}
      aria-label={name}
      data-landing={beside?.left === href ? "" : undefined}
    >
      <Icon name="expand" />
    </Link>
  );
}

export function SessionRow({
  level,
  agent,
  session,
  alone = false,
  ...actions
}: {
  // The level of the row's heading, one below its agent's, or the agents'
  // own when it stands alone.
  level: 3 | 4 | 5;
  agent: string;
  session: SessionSummary;
  // Whether it stands alone, with no agent's header above it, so it names
  // its agent too.
  alone?: boolean;
} & SessionActions) {
  const lead = useId();
  const path = sessionKey(agent, session.session);
  return (
    <li className="session-row">
      <Summary
        agent={agent}
        session={session}
        {...actions}
        heading={
          // The heading goes by its lead's name alone, as a Fold's does, so
          // the linked name beside it does not say it twice. The spaces
          // between the parts keep them apart as they are read; the layout
          // sets them apart for the eye.
          <Heading level={level} lead={lead}>
            <RowLead
              id={lead}
              href={sessionHref(agent, session.session)}
              name={`Session ${alone ? path : session.session}`}
            />{" "}
            <FilterLink
              className="session-name"
              narrowing={{ session: [path] }}
              spoken={`Threads of session ${path}`}
            >
              {alone ? path : session.session}
            </FilterLink>{" "}
            <TitleAndPercent status={session.status} />
          </Heading>
        }
      />
    </li>
  );
}

// Heading is a row's heading at its level, named by its lead.
function Heading({
  level,
  lead,
  children,
}: {
  level: 3 | 4 | 5;
  lead: string;
  children: ReactNode;
}) {
  const Tag = `h${level}` as const;
  return <Tag aria-labelledby={lead}>{children}</Tag>;
}

// RegistrationRow is a registration waiting for approval, in the group the
// rows hold them in: the agent and the session it proposes, whether each is
// new or which session approving it would replace a credential for, as when
// an agent that lost its credential registers again, when it was submitted
// and when it expires, and its code. Its chevron, and a tap anywhere else on
// it, leads to its page, which holds its approval.
export function RegistrationRow({
  registration,
  agents,
}: {
  registration: Registration;
  // The agents the view lists, which tell what it proposes, unless they
  // failed to load.
  agents: Agents | undefined;
}) {
  const lead = useId();
  const path = sessionKey(registration.proposed_agent, registration.proposed_session);
  const proposal = agents === undefined ? undefined : proposalOf(registration, agents);
  return (
    <li className="session-row waiting">
      <div className="session-summary">
        <div className="session-head">
          <Heading level={3} lead={lead}>
            <RowLead
              id={lead}
              href={registrationHref(registration.id)}
              name={`Registration ${registration.code} for ${path}`}
            />{" "}
            <span className="session-name">{path}</span>
          </Heading>
        </div>
        <p className="session-seen">
          Submitted <Time value={registration.created_at} /> · expires{" "}
          <Time value={registration.expires_at} />
        </p>
        <ul className="tags session-facts">
          {proposal !== undefined && (
            <li className={proposal.kind === "existing" ? "warning" : "accent"}>
              {proposalWords[proposal.kind]}
            </li>
          )}
          <li className="bare">
            <span className="code small">{registration.code}</span>
          </li>
        </ul>
      </div>
    </li>
  );
}

// SessionOpen is a session in its own pane, or alone on a narrower screen at
// its address: what its row shows, under the page's heading, which names it
// by its path, and beneath, its detail. Its options go by a name of their
// own, since side by side its row's stand on the page too.
export function SessionOpen({
  agent,
  session,
  ...actions
}: { agent: string; session: SessionSummary } & SessionActions) {
  return (
    <div className="session-open">
      <Summary
        agent={agent}
        session={session}
        {...actions}
        optionsLabel="Session options"
        heading={
          <PageHeading>
            <span className="session-name">{sessionKey(agent, session.session)}</span>{" "}
            <TitleAndPercent status={session.status} />
          </PageHeading>
        }
      />
      <div className="session-detail">
        <SessionDetail agent={agent} session={session} refresh={actions.refresh} />
      </div>
    </div>
  );
}

// The session's title and how far it has come, after its name in its head.
function TitleAndPercent({ status }: { status: SessionSummary["status"] }) {
  return (
    <>
      {status?.title !== undefined && <span className="session-title">{status.title}</span>}{" "}
      {status?.percent !== undefined && <span className="session-percent">{status.percent}%</span>}
    </>
  );
}

// Summary is a session's head, the heading given beside its options, over
// when it was last seen and its facts, and, beneath, the question its
// options ask before revoking a credential. The options are named for the
// session unless the caller names them (optionsLabel).
function Summary({
  agent,
  session,
  heading,
  optionsLabel,
  refresh,
  newThread,
  organize,
}: {
  agent: string;
  session: SessionSummary;
  heading: ReactNode;
  optionsLabel?: string;
} & SessionActions) {
  const options = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [revoking, setRevoking] = useState<Credential>();
  const path = sessionKey(agent, session.session);
  return (
    <>
      <div className="session-summary">
        <div className="session-head">
          {heading}
          <OptionsMenu
            label={optionsLabel ?? `Options for ${path}`}
            open={menu}
            setOpen={setMenu}
            button={options}
          >
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
        <Recency session={session} />
        <SessionFacts agent={agent} session={session} />
      </div>
      <Revocation
        asking={revoking}
        stop={() => setRevoking(undefined)}
        opener={options}
        onRevoked={refresh}
      />
    </>
  );
}

// Recency is the line under a session's head saying when it was last seen,
// in the words the thread list's headers use, and how long ago its status
// was last updated, once it has one, since a session can keep being seen
// long after its status stopped saying what it does. The line takes the
// warning's tone while the session is quiet and has not stopped, which a
// stopped session's state says already, and is said as quiet then.
function Recency({ session }: { session: SessionSummary }) {
  const { presence, status } = session;
  const quiet = presence.quiet && status?.state !== "stopped";
  const seen = presence.last_seen_at === undefined ? "Never seen" : "Last seen";
  return (
    <p className={quiet ? "session-seen last-seen warning" : "session-seen"}>
      {quiet ? <Spoken shown={seen} spoken={`Quiet, ${seen.toLowerCase()}`} /> : seen}
      {presence.last_seen_at !== undefined && (
        <>
          {" "}
          <Since value={presence.last_seen_at} />
        </>
      )}
      {status !== undefined && (
        <span className="session-status-age">
          {" "}
          · status updated <Time value={status.updated_at} />
        </span>
      )}
    </p>
  );
}

// The session's facts, under its head: each registration waiting to be
// approved onto it, linking to its page; what it is doing; Blocked on you
// while any open ask blocks its work, linking to its blocked threads, and its
// open asks, linking to its open threads; whether it has no credential; the
// operator's group and tags for it, each linking to its threads; its
// threads' roll-up, linking to them, and how many are stranded, linking to
// those, but for blocked, which leads its open asks already, and the
// envelope, linking to its unread threads; its unread updates; and its
// latest note, cut to fit, which its log holds whole.
function SessionFacts({ agent, session }: { agent: string; session: SessionSummary }) {
  const { status, open_asks: asks, threads } = session;
  const path = sessionKey(agent, session.session);
  const rollup = rollupOfSession(session);
  const scope = { narrowing: { session: [path] }, label: path };
  return (
    <ul className="tags session-facts">
      <WaitingLinks agent={agent} session={session.session} />
      <li className={status === undefined ? "muted" : stateTone[status.state]}>
        {status === undefined ? "No status" : workStateWords(status)}
      </li>
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
          <StrandedLink stranded={threads.stranded} {...scope} />
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

// WaitingLinks leads from a session's facts to each registration waiting to
// be approved onto it, a fact each, flagged in the attention tone, as open
// asks are, since it waits on the operator too.
function WaitingLinks({ agent, session }: { agent: string; session: string }) {
  const arranged = useArranged();
  return useContext(WaitingRegistrations)
    .filter((each) => each.proposed_agent === agent && each.proposed_session === session)
    .map((registration) => (
      <li key={registration.id} className="bare">
        <Link
          to={`${registrationHref(registration.id)}${arranged}`}
          aria-label={`Registration ${registration.code} waiting for approval`}
        >
          <span className="flag attention">Registration waiting</span>
        </Link>
      </li>
    ));
}

// The tone of each state's chip.
const stateTone = { working: "success", idle: "accent", stopped: undefined } as const;
