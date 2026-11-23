import {
  type GroupRef,
  type GroupsAndTags,
  groupName,
  maxTags,
  noGroup,
  tagName,
} from "@wayfarerlabs/agention-server-api";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { request } from "../../api.ts";
import { ConfirmButton, Failure, LeftOut, Loadable, Sheet } from "../../components.tsx";
import { useAction, useResource } from "../../data.ts";
import { plural } from "../../format.tsx";

// The operator's session groups and tags in the sessions view: the chips
// that show them on sessions and agents; the sheet that sets a session's
// group, and the one that sets an agent's or a session's tags, each opened
// from its options menu; and the Groups and tags sheet, which lists every
// group and tag with what it holds, to rename or remove. A sheet loads the
// groups and tags while it is open, as it opens, and says when a change
// lands by reloading the view.

const loadGroupsAndTags = () => request<GroupsAndTags>("GET", "/groups-and-tags");

// GroupChip shows a session's group, and TagChip one of a session's or an
// agent's tags, each said with its kind.
export function GroupChip({ group }: { group: GroupRef }) {
  return (
    <span className="group-chip">
      <span className="visually-hidden">Group </span>
      {group.name}
    </span>
  );
}

export function TagChip({ tag }: { tag: string }) {
  return (
    <span className="tag-chip">
      <span className="visually-hidden">Tag </span>
      {tag}
    </span>
  );
}

// nameProblem says why a name cannot be used, in the API's words for the
// rule it breaks, once anything is typed.
function nameProblem(
  schema: typeof groupName | typeof tagName,
  what: string,
  name: string,
): string | undefined {
  const read = schema.safeParse(name);
  return name === "" || read.success
    ? undefined
    : `The ${what} ${read.error.issues[0]?.message ?? "cannot be used"}.`;
}

// NameField is a sheet's one field for a name, with why it cannot be used.
function NameField({
  label,
  value,
  onChange,
  problem,
  maxLength,
  onFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  problem: string | undefined;
  maxLength: number;
  onFocus?: () => void;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        maxLength={maxLength}
        aria-invalid={problem === undefined ? undefined : true}
        aria-describedby={problem === undefined ? undefined : `${id}-error`}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
      />
      {problem !== undefined && (
        <p id={`${id}-error`} className="field-error">
          {problem}
        </p>
      )}
    </>
  );
}

// The choice of a new group, beside the groups by their ids and no group.
const newGroup = "new";

// GroupSheet sets a session's group: one of the groups, no group, or a new
// group it names, which it creates first.
export function GroupSheet({
  agent,
  session,
  group,
  onClose,
  onChanged,
}: {
  agent: string;
  session: string;
  group: GroupRef | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const id = useId();
  const known = useResource(loadGroupsAndTags);
  const action = useAction();
  const [choice, setChoice] = useState(group === undefined ? noGroup : String(group.id));
  const [name, setName] = useState("");
  const sheet = useRef<HTMLDialogElement>(null);
  const naming = choice === newGroup;
  const problem = naming ? nameProblem(groupName, "name", name.trim()) : undefined;
  const ready = !naming || (name.trim() !== "" && problem === undefined);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) {
      return;
    }
    const set = await action.run(async (csrf) => {
      let chosen = choice === noGroup ? null : Number(choice);
      if (naming) {
        // Once made, the new group is the one chosen, so a retry after
        // setting the session's group failed does not make it again.
        chosen = (await request<GroupRef>("POST", "/groups", { csrf, body: { name } })).id;
        setChoice(String(chosen));
        known.refresh();
      }
      await request("POST", `/s/${agent}/${session}/group`, { csrf, body: { group: chosen } });
      return true;
    });
    if (set === true) {
      onChanged();
      sheet.current?.close();
    }
  };
  const option = (value: string, label: ReactNode) => (
    <label className="check" key={value}>
      <input
        type="radio"
        name={id}
        value={value}
        checked={choice === value}
        onChange={() => setChoice(value)}
      />
      {label}
    </label>
  );
  return (
    <Sheet
      sheet={sheet}
      heading={`Group for ${agent}/${session}`}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      foot={
        <>
          <button type="button" className="secondary" onClick={() => sheet.current?.close()}>
            Cancel
          </button>
          <button type="submit" disabled={action.pending || !ready}>
            Save
          </button>
        </>
      }
    >
      <Loadable data={known.data} failure={known.failure} retry={known.refresh}>
        {({ groups }) => (
          <fieldset>
            <legend>Group</legend>
            {groups.map((each) => option(String(each.id), each.name))}
            {option(noGroup, "No group")}
            {option(newGroup, "New group")}
            <NameField
              label="New group's name"
              value={name}
              onChange={(value) => {
                setName(value);
                setChoice(newGroup);
              }}
              onFocus={() => setChoice(newGroup)}
              problem={problem}
              maxLength={100}
            />
          </fieldset>
        )}
      </Loadable>
      <Failure failure={action.failure} />
    </Sheet>
  );
}

// TagsSheet sets the tags an agent or a session carries: a box for each tag,
// those it carries checked, which a search box narrows as it is typed in.
// Typing a name no tag has offers to add it. Once it carries as many as it
// can, the boxes not checked are unavailable, and a line says why.
export function TagsSheet({
  heading,
  path,
  tags,
  onClose,
  onChanged,
}: {
  heading: string;
  // The API path that sets the tags.
  path: string;
  tags: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const id = useId();
  const known = useResource(loadGroupsAndTags);
  const action = useAction();
  const [chosen, setChosen] = useState(tags);
  const [text, setText] = useState("");
  const sheet = useRef<HTMLDialogElement>(null);
  const words = text.trim().toLowerCase();
  const all = [
    ...new Set([...(known.data?.tags.map((each) => each.name) ?? []), ...tags, ...chosen]),
  ].sort();
  const shown = all.filter((tag) => tag.includes(words));
  const full = chosen.length >= maxTags;
  const problem = nameProblem(tagName, "tag", words);
  const addable = words !== "" && problem === undefined && !all.includes(words);
  const toggle = (tag: string) =>
    setChosen((current) =>
      current.includes(tag) ? current.filter((each) => each !== tag) : [...current, tag],
    );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const set = await action.run((csrf) => request("POST", path, { csrf, body: { tags: chosen } }));
    if (set !== undefined) {
      onChanged();
      sheet.current?.close();
    }
  };
  return (
    <Sheet
      sheet={sheet}
      heading={heading}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      foot={
        <>
          <button type="button" className="secondary" onClick={() => sheet.current?.close()}>
            Cancel
          </button>
          <button type="submit" disabled={action.pending}>
            Save
          </button>
        </>
      }
    >
      <input
        type="search"
        aria-label="Search or add tags"
        placeholder="Search or add tags"
        maxLength={63}
        value={text}
        aria-invalid={words !== "" && problem !== undefined ? true : undefined}
        aria-describedby={words !== "" && problem !== undefined ? `${id}-error` : undefined}
        onChange={(event) => setText(event.target.value)}
      />
      {words !== "" && problem !== undefined && (
        <p id={`${id}-error`} className="field-error">
          {problem}
        </p>
      )}
      {addable && (
        <button
          type="button"
          className="secondary"
          disabled={full}
          onClick={() => {
            setChosen((current) => [...current, words]);
            setText("");
          }}
        >
          Add tag {words}
        </button>
      )}
      <Loadable data={known.data} failure={known.failure} retry={known.refresh}>
        {() =>
          shown.length === 0 ? (
            <p className="muted">{all.length === 0 ? "No tags yet." : "None match."}</p>
          ) : (
            <ul className="picks">
              {shown.map((tag) => (
                <li key={tag}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={chosen.includes(tag)}
                      disabled={full && !chosen.includes(tag)}
                      aria-describedby={full && !chosen.includes(tag) ? `${id}-full` : undefined}
                      onChange={() => toggle(tag)}
                    />
                    {tag}
                  </label>
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
      {full && (
        <p id={`${id}-full`} className="muted">
          At most {maxTags} tags can be on one.
        </p>
      )}
      <Failure failure={action.failure} />
    </Sheet>
  );
}

// GroupsAndTagsSheet lists every group, with how many sessions it holds, and
// every tag, with how many agents and sessions carry it, each to rename or
// remove, and adds a group. Removing asks first, in the sheet, saying what it
// takes the group or tag off.
export function GroupsAndTagsSheet({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const known = useResource(loadGroupsAndTags);
  const sheet = useRef<HTMLDialogElement>(null);
  const changed = () => {
    known.refresh();
    onChanged();
  };
  return (
    <Sheet
      sheet={sheet}
      heading="Groups and tags"
      onClose={onClose}
      foot={
        <button type="button" onClick={() => sheet.current?.close()}>
          Done
        </button>
      }
    >
      <Loadable data={known.data} failure={known.failure} retry={known.refresh}>
        {({ groups, tags, truncated }) => (
          <>
            <h3>Groups</h3>
            {groups.length === 0 ? (
              <p className="muted">No groups yet.</p>
            ) : (
              <ul className="organizer">
                {groups.map((group) => (
                  <Organized
                    key={group.id}
                    kind="group"
                    name={group.name}
                    holds={plural(group.sessions, "session")}
                    path={`/groups/${group.id}`}
                    removing={
                      group.sessions === 0
                        ? `Remove the group ${group.name}?`
                        : `Remove the group ${group.name}? Its ${plural(group.sessions, "session")} will be in no group.`
                    }
                    onChanged={changed}
                  />
                ))}
              </ul>
            )}
            <h3>Tags</h3>
            {tags.length === 0 ? (
              <p className="muted">No tags yet. Add them from an agent's or a session's options.</p>
            ) : (
              <ul className="organizer">
                {tags.map((tag) => {
                  const carriers = [
                    ...(tag.agents > 0 ? [plural(tag.agents, "agent")] : []),
                    ...(tag.sessions > 0 ? [plural(tag.sessions, "session")] : []),
                  ];
                  return (
                    <Organized
                      key={tag.name}
                      kind="tag"
                      name={tag.name}
                      holds={carriers.join(", ")}
                      path={`/tags/${tag.name}`}
                      removing={`Remove the tag ${tag.name} from ${carriers.join(" and ")}?`}
                      onChanged={changed}
                    />
                  );
                })}
              </ul>
            )}
            {truncated && <LeftOut items="tags" />}
          </>
        )}
      </Loadable>
    </Sheet>
  );
}

// Organized is one group or tag in the sheet: its name and what it holds,
// with Rename, which opens a field for its new name in its place, and
// Remove, which asks first.
function Organized({
  kind,
  name,
  holds,
  path,
  removing,
  onChanged,
}: {
  kind: "group" | "tag";
  name: string;
  holds: string;
  // The API path of the group or tag.
  path: string;
  // The question Remove asks.
  removing: string;
  onChanged: () => void;
}) {
  const action = useAction();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(name);
  const schema = kind === "group" ? groupName : tagName;
  const typed = kind === "group" ? newName.trim() : newName.trim().toLowerCase();
  const problem = nameProblem(schema, "name", typed);
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (typed === "" || problem !== undefined) {
      return;
    }
    const done = await action.run((csrf) =>
      request("POST", `${path}/name`, { csrf, body: { name: typed } }),
    );
    if (done !== undefined) {
      setRenaming(false);
      onChanged();
    }
  };
  const remove = async () => {
    const done = await action.run((csrf) => request("POST", `${path}/remove`, { csrf }));
    if (done !== undefined) {
      onChanged();
    }
  };
  const label = kind === "group" ? `Group ${name}` : `Tag ${name}`;
  return (
    <li>
      <article className="organized" aria-label={label}>
        <p>
          <span className={kind === "group" ? "group-name" : "tag-name"}>{name}</span>{" "}
          <span className="muted">{holds}</span>
        </p>
        {renaming ? (
          <form noValidate onSubmit={(event) => void rename(event)}>
            <NameField
              label="New name"
              value={newName}
              onChange={setNewName}
              problem={problem}
              maxLength={kind === "group" ? 100 : 63}
            />
            <div className="actions">
              <button type="submit" disabled={action.pending}>
                Save
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setRenaming(false);
                  setNewName(name);
                  action.clear();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setRenaming(true)}>
              Rename
            </button>
            <ConfirmButton
              label="Remove"
              confirmLabel={`Remove this ${kind}`}
              question={removing}
              disabled={action.pending}
              onConfirm={() => void remove()}
            />
          </div>
        )}
        <Failure failure={action.failure} />
      </article>
    </li>
  );
}
