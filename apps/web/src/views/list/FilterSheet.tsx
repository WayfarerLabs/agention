import {
  agentReadFilter,
  asksOff,
  effortFilter,
  impactFilter,
  maxNarrowed,
  priorityFilter,
  statusKept,
  type ThreadCounts,
  type ThreadsView,
  threadStatus,
} from "@wayfarerlabs/agention-api";
import { type KeyboardEvent, type RefObject, useCallback, useId, useRef, useState } from "react";
import { LeftOut, PathBadge, type PathKind, pathWord, useTapOutside } from "../../components.tsx";
import { effortLabel, plain, plural, Spoken, statusLabel, type TerseLabel } from "../../format.tsx";
import { Icon } from "../../icons.tsx";
import { impactShown, priorityAtLeast } from "./Chips.tsx";
import { sessionOf, topicShown } from "./listing.ts";

// The filter sheet holds every filter, in a modal dialog: a sheet from the
// bottom on a phone, a panel on a wide screen. The list behind it follows
// each change. Every value not chosen shows how many threads it keeps with
// every other filter as it is, from the counts loaded while the sheet is
// open; every option of Agent, Session and Topic shows its count, chosen or
// not, since choosing one changes no other's.

// The words a value is said in beside its count.
const threads = (count: number) => plural(count, "thread");

// Counted labels a value with its count, as "Unread (4)", said "Unread, 4
// threads"; without a count, it is the label alone.
function Counted({ label, count }: { label: TerseLabel; count: number | undefined }) {
  return count === undefined ? (
    <Spoken {...label} />
  ) : (
    <Spoken shown={`${label.shown} (${count})`} spoken={`${label.spoken}, ${threads(count)}`} />
  );
}

interface SegmentOption {
  value: string;
  label: TerseLabel;
  count?: number | undefined;
}

// Segmented chooses one value of a filter from a row of radio buttons, the
// first of which turns the filter off. Each value not chosen shows its count.
function Segmented({
  legend,
  value,
  options,
  choose,
}: {
  legend: string;
  value: string;
  options: SegmentOption[];
  choose: (value: string) => void;
}) {
  const name = useId();
  return (
    <fieldset className="segmented">
      <legend>{legend}</legend>
      <div className="segments">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => choose(option.value)}
            />
            <span className="segment">
              <Counted
                label={option.label}
                count={value === option.value ? undefined : option.count}
              />
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// An option of a multi-select: its value, which names it whole, as said and
// as its tooltip; its name, and what it belongs to, shown muted beside it;
// and its count.
interface Choice {
  value: string;
  name: string;
  of?: string | undefined;
  count: number;
}

// MultiSelect chooses up to maxNarrowed of the values of a filter on where
// threads are: its part's badge and word, a button naming what is chosen,
// which discloses a popup beneath it, within the sheet's flow so nothing
// clips it: a search box that narrows the options by what they show, a checkbox for
// each, saying when the counts left some out, and Done. Once as many as the
// list takes are chosen, the boxes not checked are unavailable, and a line
// says why. Escape, Done or a tap outside closes it, returning focus to its
// button, as a message's options do.
function MultiSelect({
  kind,
  searchLabel,
  nameOf,
  choices,
  truncated,
  chosen,
  choose,
  open,
  setOpen,
}: {
  kind: PathKind;
  searchLabel: string;
  // The name a value is shown by.
  nameOf: (value: string) => string;
  // Undefined until the counts that list them arrive.
  choices: Choice[] | undefined;
  // Whether the counts left some out.
  truncated: boolean;
  chosen: string[];
  choose: (values: string[]) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState("");
  const shut = useCallback(() => setOpen(false), [setOpen]);
  useTapOutside(open, root, button, shut);
  const close = () => {
    shut();
    button.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Escape closes the popup, not the sheet around it.
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  const [first] = chosen;
  const summary =
    first === undefined ? "Any" : chosen.length === 1 ? nameOf(first) : `${chosen.length} chosen`;
  const words = text.trim().toLowerCase();
  const shown = (choices ?? []).filter(
    (choice) =>
      choice.name.toLowerCase().includes(words) || choice.of?.toLowerCase().includes(words),
  );
  const toggle = (value: string) =>
    choose(chosen.includes(value) ? chosen.filter((each) => each !== value) : [...chosen, value]);
  const full = chosen.length >= maxNarrowed;
  return (
    <div className="multi-select" ref={root} onKeyDown={onKeyDown}>
      <span id={`${id}-label`} className="field-label">
        <PathBadge kind={kind} /> {pathWord(kind)}
      </span>
      <button
        ref={button}
        type="button"
        className="secondary picker"
        aria-expanded={open}
        aria-controls={open ? `${id}-popup` : undefined}
        aria-labelledby={`${id}-label ${id}-summary`}
        onClick={() => setOpen(!open)}
      >
        <span id={`${id}-summary`}>{summary}</span>
        <Icon name="expand" />
      </button>
      {open && (
        <div id={`${id}-popup`} className="popup" role="group" aria-labelledby={`${id}-label`}>
          <input
            type="search"
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {choices === undefined ? (
            <p className="muted">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="muted">{choices.length === 0 ? "None yet." : "None match."}</p>
          ) : (
            <ul className="picks">
              {shown.map((choice) => (
                <li key={choice.value}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={chosen.includes(choice.value)}
                      disabled={full && !chosen.includes(choice.value)}
                      aria-describedby={
                        full && !chosen.includes(choice.value) ? `${id}-full` : undefined
                      }
                      aria-label={`${choice.value}, ${threads(choice.count)}`}
                      onChange={() => toggle(choice.value)}
                    />
                    <span className="pick" title={choice.value}>
                      {choice.name}
                      {choice.of !== undefined && <span className="pick-of"> {choice.of}</span>}
                      <span className="pick-count"> ({choice.count})</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {full && (
            <p id={`${id}-full`} className="muted">
              At most {maxNarrowed} can be chosen.
            </p>
          )}
          {truncated && <LeftOut />}
          <button type="button" className="secondary" onClick={close}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}

const anyLabel = plain("Any");

// The search box's text, and why it cannot search when the API would refuse
// it.
export interface SearchText {
  text: string;
  problem: string | undefined;
  type: (text: string) => void;
}

// FilterSheet's dialog closes by its button or Escape, which returns focus to
// the button that opened it; a popup open within it closes first.
export function FilterSheet({
  sheet,
  heading,
  opener,
  view,
  search,
  total,
  counts,
  choose,
  reset,
  onClose,
}: {
  sheet: RefObject<HTMLDialogElement | null>;
  heading: RefObject<HTMLHeadingElement | null>;
  opener: RefObject<HTMLButtonElement | null>;
  view: ThreadsView;
  search: SearchText;
  total: number | undefined;
  counts: ThreadCounts | undefined;
  choose: (change: Partial<ThreadsView>) => void;
  reset: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [popup, setPopup] = useState<PathKind>();
  const popupOf = (which: PathKind) => ({
    open: popup === which,
    setOpen: (open: boolean) =>
      setPopup((current) => (open ? which : current === which ? undefined : current)),
  });
  const agents = counts?.agent.agents.map((each) => ({
    value: each.agent,
    name: each.agent,
    count: each.total,
  }));
  const { agent: chosenAgents = [], session: chosenSessions = [], topic: chosenTopics = [] } = view;
  // narrowing is what choosing values of a filter taking several sets it to:
  // with none chosen, it is off.
  const narrowing = (chosen: string[]) => (chosen.length === 0 ? undefined : chosen);
  // chooseAsk chooses a property of open asks, which keeps only open threads:
  // a value chosen under another status chooses Open.
  const chooseAsk = (change: Partial<ThreadsView>) =>
    choose(
      view.status !== undefined && Object.values(change).some((value) => value)
        ? { ...change, status: "open" }
        : change,
    );
  // Sessions and topics are offered as what is chosen above them narrows
  // them, each shown beside its agent and searched by both.
  const sessions = counts?.session.sessions
    .map((each) => ({
      value: `${each.agent}/${each.session}`,
      name: each.session,
      of: each.agent,
      count: each.total,
    }))
    .filter((each) => onOffer(view, "session", each.value));
  const topics = counts?.topic.topics
    .map((each) => ({
      value: `${each.agent}/${each.session}/${each.topic}`,
      name: `${each.session}/${each.topic}`,
      of: each.agent,
      count: each.total,
    }))
    .filter((each) => onOffer(view, "topic", each.value));
  return (
    <dialog
      ref={sheet}
      className="sheet"
      aria-labelledby={`${id}-title`}
      onClose={() => {
        setPopup(undefined);
        onClose();
        opener.current?.focus();
      }}
    >
      <div className="sheet-body">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
          Filters
        </h2>
        <label htmlFor={`${id}-search`}>Search titles</label>
        <input
          id={`${id}-search`}
          type="search"
          maxLength={200}
          value={search.text}
          aria-invalid={search.problem === undefined ? undefined : true}
          aria-describedby={search.problem === undefined ? undefined : `${id}-search-error`}
          onChange={(event) => search.type(event.target.value)}
        />
        {search.problem !== undefined && (
          <p id={`${id}-search-error`} className="field-error">
            {search.problem}
          </p>
        )}
        {/* Open whenever a property of open asks narrows the list, which
            keeps only open threads; choosing another status turns those off,
            and choosing a property under another status chooses Open. */}
        <Segmented
          legend="Status"
          value={statusKept(view) ?? ""}
          options={[
            { value: "", label: anyLabel, count: counts?.status.any },
            ...threadStatus.options.map((status) => ({
              value: status,
              label: statusLabel[status],
              count: counts?.status[status],
            })),
          ]}
          choose={(value) => {
            const status = threadStatus.safeParse(value).data;
            choose(status === "open" ? { status } : { status, ...asksOff });
          }}
        />
        <div className="sub-filters">
          <Segmented
            legend="Priority"
            value={view.priority ?? ""}
            options={[
              { value: "", label: anyLabel, count: counts?.priority.any },
              ...priorityFilter.options.map((level) => ({
                value: level,
                label: priorityAtLeast[level],
                count: counts?.priority[level],
              })),
            ]}
            choose={(value) => chooseAsk({ priority: priorityFilter.safeParse(value).data })}
          />
          <Segmented
            legend="Impact"
            value={view.impact ?? ""}
            options={[
              { value: "", label: anyLabel, count: counts?.impact.any },
              ...impactFilter.options.map((level) => ({
                value: level,
                label: plain(impactShown[level]),
                count: counts?.impact[level],
              })),
            ]}
            choose={(value) => chooseAsk({ impact: impactFilter.safeParse(value).data })}
          />
          <Segmented
            legend="Due"
            value={view.overdue ? "overdue" : ""}
            options={[
              { value: "", label: anyLabel, count: counts?.overdue.any },
              { value: "overdue", label: plain("Overdue"), count: counts?.overdue.overdue },
            ]}
            choose={(value) => chooseAsk({ overdue: value === "overdue" })}
          />
          <Segmented
            legend="Effort"
            value={view.effort ?? ""}
            options={[
              { value: "", label: anyLabel, count: counts?.effort.any },
              ...effortFilter.options.map((level) => ({
                value: level,
                label: effortLabel[level],
                count: counts?.effort[level],
              })),
            ]}
            choose={(value) => chooseAsk({ effort: effortFilter.safeParse(value).data })}
          />
        </div>
        <Segmented
          legend="Read"
          value={view.unread ? "unread" : ""}
          options={[
            { value: "", label: anyLabel, count: counts?.unread.any },
            { value: "unread", label: plain("Unread"), count: counts?.unread.unread },
          ]}
          choose={(value) => choose({ unread: value === "unread" })}
        />
        {/* Stranded: unread by an agent that is not there to read it. */}
        <Segmented
          legend="Read by agent"
          value={view.agent_read ?? ""}
          options={[
            { value: "", label: anyLabel, count: counts?.agent_read.any },
            { value: "unread", label: plain("Unread"), count: counts?.agent_read.unread },
            { value: "stranded", label: plain("Stranded"), count: counts?.agent_read.stranded },
          ]}
          choose={(value) => choose({ agent_read: agentReadFilter.safeParse(value).data })}
        />
        <div className="chooser">
          <MultiSelect
            kind="agent"
            searchLabel="Search agents"
            nameOf={(agent) => agent}
            choices={agents}
            truncated={counts?.agent.truncated === true}
            chosen={chosenAgents}
            choose={(chosen) => choose({ agent: narrowing(chosen) })}
            {...popupOf("agent")}
          />
          <MultiSelect
            kind="session"
            searchLabel="Search sessions"
            nameOf={(path) => sessionOf(path).session}
            choices={sessions}
            truncated={counts?.session.truncated === true}
            chosen={chosenSessions}
            choose={(chosen) => choose({ session: narrowing(chosen) })}
            {...popupOf("session")}
          />
          <MultiSelect
            kind="topic"
            searchLabel="Search topics"
            nameOf={topicShown}
            choices={topics}
            truncated={counts?.topic.truncated === true}
            chosen={chosenTopics}
            choose={(chosen) => choose({ topic: narrowing(chosen) })}
            {...popupOf("topic")}
          />
        </div>
        <Segmented
          legend="Archived"
          value={view.include_archived ? "show" : ""}
          options={[
            { value: "", label: plain("Hide"), count: counts?.include_archived.hide },
            { value: "show", label: plain("Show"), count: counts?.include_archived.show },
          ]}
          choose={(value) => choose({ include_archived: value === "show" })}
        />
      </div>
      <div className="sheet-foot">
        <button type="button" className="secondary" onClick={reset}>
          <Counted label={plain("Reset filters")} count={counts?.reset} />
        </button>
        <button type="button" onClick={() => sheet.current?.close()}>
          {total === undefined ? "Show threads" : `Show ${threads(total)}`}
        </button>
      </div>
    </dialog>
  );
}

// onOffer says whether the sheet offers a session or a topic, by its path:
// one already chosen always; a topic within the sessions chosen, while any
// are; otherwise one of the agents chosen, while any are; and otherwise
// every one.
function onOffer(view: ThreadsView, kind: "session" | "topic", path: string): boolean {
  const { agent: agents = [], session: sessions = [] } = view;
  const [agent = "", session = ""] = path.split("/");
  if ((view[kind] ?? []).includes(path)) {
    return true;
  }
  if (kind === "topic" && sessions.length > 0) {
    return sessions.includes(`${agent}/${session}`);
  }
  return agents.length === 0 || agents.includes(agent);
}
