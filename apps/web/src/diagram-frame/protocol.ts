// The messages between the page and the diagram frame. The page posts a
// request to the frame; the frame answers it with the diagram's SVG or an
// error. Each side reads the other's messages through these readers, since a
// message is only data until its shape is checked: the frame draws hostile
// text, so the page trusts nothing it answers beyond its shape.

// The longest source, in characters, that is sent to be drawn. Longer
// sources show as their text.
export const maxDiagramSource = 10_000;

// The Mermaid themes that match the app's light and dark color schemes.
export type DiagramTheme = "default" | "dark";

export interface DrawRequest {
  id: number;
  source: string;
  theme: DiagramTheme;
}

export type DrawAnswer =
  { id: number; svg: string; title?: string; description?: string } | { id: number; error: string };

// tooLongToDraw says whether a source is over maxDiagramSource, counting
// characters as code points, as the API counts text.
export function tooLongToDraw(source: string): boolean {
  if (source.length <= maxDiagramSource) {
    return false;
  }
  let count = 0;
  for (const _ of source) {
    if (++count > maxDiagramSource) {
      return true;
    }
  }
  return false;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

// readRequest returns the request a message holds, or undefined when it holds
// none.
export function readRequest(data: unknown): DrawRequest | undefined {
  if (!isRecord(data) || !isId(data.id) || typeof data.source !== "string") {
    return undefined;
  }
  if (data.theme !== "default" && data.theme !== "dark") {
    return undefined;
  }
  return { id: data.id, source: data.source, theme: data.theme };
}

// readAnswer returns the answer a message holds, or undefined when it holds
// none.
export function readAnswer(data: unknown): DrawAnswer | undefined {
  if (!isRecord(data) || !isId(data.id)) {
    return undefined;
  }
  if (typeof data.error === "string") {
    return { id: data.id, error: data.error };
  }
  if (
    typeof data.svg !== "string" ||
    !optionalText(data.title) ||
    !optionalText(data.description)
  ) {
    return undefined;
  }
  return {
    id: data.id,
    svg: data.svg,
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.description === undefined ? {} : { description: data.description }),
  };
}
