import type { GroupsAndTags } from "@wayfarerlabs/agention-api";
import { useId } from "react";
import { request } from "../../api.ts";
import { Failure, LeftOut, useFocusWhenShown } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { plural } from "../../format.tsx";
import { focusNext, HoldsLink, ListHead, Organized, useSearch } from "./Organizer.tsx";

type Tag = GroupsAndTags["tags"][number];

// TagList is Settings' list of tags, in name order, those nothing carries
// among them. A tag goes by its name, so one renamed shows under its new name
// once the list reloads, where focus follows it.
export function TagList({
  tags,
  truncated,
  refresh,
}: {
  tags: Tag[];
  truncated: boolean;
  refresh: () => void;
}) {
  const id = useId();
  const [search, words] = useSearch("Search tags");
  const create = useAction();
  const focus = useFocusWhenShown(tags);
  const shown = tags.filter((tag) => tag.name.includes(words));
  const rowOf = (tag: string) => `${id}-row-${tag}`;
  return (
    <section aria-labelledby={`${id}-heading`} className="organizer-section">
      <ListHead
        heading="Tags"
        headingId={`${id}-heading`}
        newId={`${id}-new`}
        kind="tag"
        search={search}
        create={async (name) => {
          const made = await create.run((csrf) =>
            request("POST", "/tags", { csrf, body: { name } }),
          );
          refresh();
          return made !== undefined;
        }}
      />
      <Failure failure={create.failure} />
      {tags.length === 0 ? (
        <p className="muted">No tags yet.</p>
      ) : shown.length === 0 ? (
        <p className="muted">None match.</p>
      ) : (
        <ul className="organizer">
          {shown.map((tag) => {
            const carriers = [
              ...(tag.agents > 0 ? [plural(tag.agents, "agent")] : []),
              ...(tag.sessions > 0 ? [plural(tag.sessions, "session")] : []),
            ];
            return (
              <Organized
                key={tag.name}
                kind="tag"
                name={tag.name}
                color={tag.color}
                path={`/tags/${tag.name}`}
                holds={
                  carriers.length === 0 ? (
                    <span className="muted">On nothing</span>
                  ) : (
                    <HoldsLink
                      narrowing={{ tag: [tag.name] }}
                      words={carriers.join(", ")}
                      of={`tagged ${tag.name}`}
                    />
                  )
                }
                removing={
                  carriers.length === 0
                    ? `Remove the tag ${tag.name}? Nothing carries it.`
                    : `Remove the tag ${tag.name} from ${carriers.join(" and ")}?`
                }
                refresh={refresh}
                rowId={rowOf(tag.name)}
                onRenamed={(name) => focus(`${rowOf(name)}-rename`)}
                onRemoved={() =>
                  focusNext(
                    shown.map((each) => rowOf(each.name)),
                    shown.indexOf(tag),
                    `${id}-new`,
                  )
                }
              />
            );
          })}
        </ul>
      )}
      {truncated && <LeftOut items="tags" />}
    </section>
  );
}
