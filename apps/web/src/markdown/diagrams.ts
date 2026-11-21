import { type DiagramTheme, type DrawRequest, readAnswer } from "../diagram-frame/protocol.ts";

// Drawing diagrams from message text. Mermaid never runs in the app's page:
// the page holds one sandboxed frame, created for its first diagram, that
// draws them and answers with SVG, which the page shows as an image. An image
// runs no script and loads nothing.
//
// Diagrams are drawn one at a time, in the order they are asked for. One
// that the frame does not answer within drawTimeout of being posted to it,
// or whose frame does not load within loadTimeout, fails, and its frame is
// thrown away, so the next gets a new one; one that is too long to draw, or
// that Mermaid cannot draw, fails too. A frame that loops on the page's own
// thread freezes the page and this timer with it, which only the size cap
// and Mermaid's own limits defend against.

// The frame's page, which the server serves with a policy of its own.
export const diagramFramePath = "/diagram-frame";

// How long a diagram may take to be drawn, from when it is posted to a loaded
// frame.
export const drawTimeout = 10_000;

// How long a frame may take to load, its script included, which a phone on a
// slow link may take far longer to fetch than a diagram takes to draw.
export const loadTimeout = 60_000;

export interface Drawing {
  svg: string;
  title?: string;
  description?: string;
}

interface Job {
  request: DrawRequest;
  // Settles the diagram's draw: the drawing, or undefined when it failed.
  settle: (drawing: Drawing | undefined) => void;
  signal: AbortSignal;
}

interface Frame {
  element: HTMLIFrameElement;
  loaded: Promise<void>;
}

// The diagram being drawn, the frame drawing it, and its timer.
interface Current {
  job: Job;
  frame: Frame;
  timer: number | undefined;
}

// DiagramDrawer holds a page's frame and the diagrams waiting for it.
export class DiagramDrawer {
  readonly #document: Document;
  #nextId = 1;
  #queue: Job[] = [];
  #current: Current | undefined;
  #frame: Frame | undefined;

  constructor(document: Document) {
    this.#document = document;
    document.defaultView?.addEventListener("message", (event) => this.#answered(event));
  }

  // draw asks for a diagram in the theme given, and settles with its
  // drawing, or undefined when it cannot be drawn. A draw that is aborted
  // never settles, and leaves the queue.
  draw(source: string, theme: DiagramTheme, signal: AbortSignal): Promise<Drawing | undefined> {
    return new Promise((settle) => {
      const job = { request: { id: this.#nextId++, source, theme }, settle, signal };
      this.#queue.push(job);
      signal.addEventListener("abort", () => this.#abandon(job), { once: true });
      this.#next();
    });
  }

  // #abandon drops an aborted draw that is still waiting. One already sent is
  // drawn on, and its answer ignored.
  #abandon(job: Job): void {
    this.#queue = this.#queue.filter((waiting) => waiting !== job);
  }

  #next(): void {
    if (this.#current !== undefined) {
      return;
    }
    const job = this.#queue.shift();
    if (job === undefined) {
      return;
    }
    const frame = (this.#frame ??= this.#newFrame());
    const current: Current = { job, frame, timer: undefined };
    this.#current = current;
    // A frame that has not loaded within loadTimeout, as one still fetching
    // its script over a slow link may not have, is thrown away as one that
    // never answers is.
    current.timer = this.#giveUp(current, loadTimeout);
    void frame.loaded.then(() => {
      if (this.#current !== current) {
        return;
      }
      this.#document.defaultView?.clearTimeout(current.timer);
      current.timer = this.#giveUp(current, drawTimeout);
      // The frame's origin is opaque, so no target origin can name it; the
      // app's own policy lets the frame hold only the frame's page.
      frame.element.contentWindow?.postMessage(job.request, "*");
    });
  }

  // #giveUp arms the timer after which the diagram being drawn fails and its
  // frame is thrown away, so the next diagram gets a new one.
  #giveUp(current: Current, after: number): number | undefined {
    return this.#document.defaultView?.setTimeout(() => {
      current.frame.element.remove();
      if (this.#frame === current.frame) {
        this.#frame = undefined;
      }
      this.#finish(current, undefined);
    }, after);
  }

  #finish(current: Current, drawing: Drawing | undefined): void {
    this.#document.defaultView?.clearTimeout(current.timer);
    this.#current = undefined;
    if (!current.job.signal.aborted) {
      current.job.settle(drawing);
    }
    this.#next();
  }

  #newFrame(): Frame {
    const element = this.#document.createElement("iframe");
    element.className = "diagram-frame";
    element.setAttribute("sandbox", "allow-scripts");
    element.setAttribute("aria-hidden", "true");
    element.tabIndex = -1;
    element.title = "Diagram drawing";
    element.src = diagramFramePath;
    const loaded = new Promise<void>((resolve) =>
      element.addEventListener("load", () => resolve(), { once: true }),
    );
    this.#document.body.append(element);
    return { element, loaded };
  }

  // #answered takes an answer from the window of the frame drawing a
  // diagram, to that diagram, and ignores every other message.
  #answered(event: MessageEvent): void {
    const current = this.#current;
    if (
      current === undefined ||
      event.source === null ||
      event.source !== current.frame.element.contentWindow
    ) {
      return;
    }
    const answer = readAnswer(event.data);
    if (answer === undefined || answer.id !== current.job.request.id) {
      return;
    }
    if ("error" in answer) {
      this.#finish(current, undefined);
      return;
    }
    const { svg, title, description } = answer;
    this.#finish(current, {
      svg,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    });
  }
}

let pageDrawer: DiagramDrawer | undefined;

// drawDiagram draws a diagram with the page's one drawer.
export function drawDiagram(
  source: string,
  theme: DiagramTheme,
  signal: AbortSignal,
): Promise<Drawing | undefined> {
  pageDrawer ??= new DiagramDrawer(document);
  return pageDrawer.draw(source, theme, signal);
}
