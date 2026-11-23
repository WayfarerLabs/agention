import type { Color, GroupId, GroupsAndTags, groupName, tagName } from "@wayfarerlabs/agention-api";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { request } from "./api.ts";

// The operator's session groups and tags as every view shows them: each a
// chip in its color, from the palette of named colors the API offers, which
// the stylesheet draws in tones for the light and the dark scheme alike. The
// views that show groups and tags load the operator's groups and tags and
// give their colors and the groups' order to what they show through a
// palette; a group or a tag the palette does not know shows in no color.

export const loadGroupsAndTags = () => request<GroupsAndTags>("GET", "/groups-and-tags");

// nameProblem says why a name cannot be used, in the API's words for the
// rule it breaks.
export function nameProblem(
  schema: typeof groupName | typeof tagName,
  what: string,
  name: string,
): string | undefined {
  const read = schema.safeParse(name);
  return read.success
    ? undefined
    : `The ${what} ${read.error.issues[0]?.message ?? "cannot be used"}.`;
}

// A group's name for comparing it with another's: ignoring the case of
// ASCII letters, as the server compares them.
export const nameKey = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

// Each color's name, as a control offering it says it.
export const colorName: Record<Color, string> = {
  gray: "Gray",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
};

// What a view knows of the operator's groups and tags: each one's color.
export interface Palette {
  group: (id: GroupId) => Color | undefined;
  tag: (name: string) => Color | undefined;
}

// paletteOf reads a palette from the operator's groups and tags, while they
// are known.
function paletteOf(known: GroupsAndTags | undefined): Palette {
  const groups = new Map(known?.groups.map((group) => [group.id, group.color]));
  const tags = new Map(known?.tags.map((tag) => [tag.name, tag.color]));
  return {
    group: (id) => groups.get(id),
    tag: (name) => tags.get(name),
  };
}

const PaletteContext = createContext<Palette>(paletteOf(undefined));

// PaletteProvider gives what it holds the palette of the groups and tags a
// view loaded.
export function PaletteProvider({
  known,
  children,
}: {
  known: GroupsAndTags | undefined;
  children: ReactNode;
}) {
  const palette = useMemo(() => paletteOf(known), [known]);
  return <PaletteContext.Provider value={palette}>{children}</PaletteContext.Provider>;
}

export const usePalette = (): Palette => useContext(PaletteContext);

// toneOf is the class that draws something in a color, or none.
export const toneOf = (color: Color | undefined): string =>
  color === undefined ? "" : ` tone-${color}`;

// OrganizedChip shows a group or a tag by its name, in its color: a group's
// chip with a dashed border, and a tag's led by a muted hash. Its kind is said
// for assistive technology where nothing around it says it.
export function OrganizedChip({
  kind,
  name,
  color,
  spoken = false,
}: {
  kind: "group" | "tag";
  name: string;
  color: Color | undefined;
  spoken?: boolean;
}) {
  return (
    <span className={`${kind}-chip${toneOf(color)}`}>
      {spoken && <span className="visually-hidden">{kind === "group" ? "Group " : "Tag "}</span>}
      {name}
    </span>
  );
}

// Swatch marks something with a color for the eye alone, as a dot before a
// group's name in a header.
export function Swatch({ color }: { color: Color | undefined }) {
  return color === undefined ? null : (
    <span className={`swatch${toneOf(color)}`} aria-hidden="true" />
  );
}
