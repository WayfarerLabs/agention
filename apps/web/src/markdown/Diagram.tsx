import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { type DiagramTheme, tooLongToDraw } from "../diagram-frame/protocol.ts";
import { DiagramViewer } from "./DiagramViewer.tsx";
import { drawDiagram } from "./diagrams.ts";
import { SvgImage } from "./SvgImage.tsx";

// A Mermaid diagram from message text, drawn in the page's diagram frame and
// shown as an image at its natural size, capped at the column's width. Its
// alternative text is the title the diagram declares, and its description,
// when it declares one, describes it. A tap opens it full screen; Source
// shows the text it was drawn from. A diagram too long to draw, or that
// cannot be drawn, shows its source instead, with a note saying which. It is
// drawn again when the color scheme changes, and its SVG is kept for that
// and for the viewer.

const darkScheme = "(prefers-color-scheme: dark)";

function subscribeToScheme(changed: () => void): () => void {
  const query = window.matchMedia(darkScheme);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}

// useDiagramTheme is the Mermaid theme that matches the app's color scheme.
function useDiagramTheme(): DiagramTheme {
  return useSyncExternalStore(
    subscribeToScheme,
    () => (window.matchMedia(darkScheme).matches ? "dark" : "default"),
    () => "default",
  );
}

type State =
  | { kind: "drawing" }
  | { kind: "failed" }
  | { kind: "drawn"; svg: string; alt: string; description: string | undefined };

export function Diagram({ source }: { source: string }) {
  const theme = useDiagramTheme();
  const [state, setState] = useState<State>({ kind: "drawing" });
  const [showSource, setShowSource] = useState(false);
  const [viewing, setViewing] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const tooLong = tooLongToDraw(source);

  useEffect(() => {
    if (tooLong) {
      return undefined;
    }
    const abort = new AbortController();
    void drawDiagram(source, theme, abort.signal).then((drawing) => {
      if (abort.signal.aborted) {
        return;
      }
      if (drawing === undefined) {
        setState({ kind: "failed" });
        return;
      }
      // An earlier drawing stays shown until this one replaces it.
      setState({
        kind: "drawn",
        svg: drawing.svg,
        alt: drawing.title ?? "Diagram",
        description: drawing.description,
      });
    });
    return () => abort.abort();
  }, [source, theme, tooLong]);

  if (tooLong) {
    return <Fallback source={source} note="This diagram is too long to draw" />;
  }
  if (state.kind === "failed") {
    return <Fallback source={source} note="This diagram could not be drawn" />;
  }
  if (state.kind === "drawing") {
    return (
      <figure className="diagram" aria-busy="true">
        <p className="diagram-note">Drawing the diagram</p>
      </figure>
    );
  }
  return (
    <figure className="diagram">
      <button
        ref={opener}
        type="button"
        className="diagram-open"
        aria-haspopup="dialog"
        aria-describedby={state.description === undefined ? undefined : descriptionId}
        onClick={() => setViewing(true)}
      >
        <SvgImage svg={state.svg} alt={state.alt} />
      </button>
      {state.description !== undefined && (
        <span id={descriptionId} className="visually-hidden">
          {state.description}
        </span>
      )}
      <button
        type="button"
        className="link"
        aria-expanded={showSource}
        onClick={() => setShowSource((shown) => !shown)}
      >
        Source
      </button>
      {showSource && (
        <pre>
          <code>{source}</code>
        </pre>
      )}
      {viewing && (
        <DiagramViewer
          svg={state.svg}
          alt={state.alt}
          onClose={() => {
            setViewing(false);
            opener.current?.focus();
          }}
        />
      )}
    </figure>
  );
}

// Fallback is a diagram that is not drawn: its note says why, and its source
// shows instead.
function Fallback({ source, note }: { source: string; note: string }) {
  return (
    <figure className="diagram">
      <p className="diagram-note">{note}, so its source shows instead.</p>
      <pre>
        <code>{source}</code>
      </pre>
    </figure>
  );
}
