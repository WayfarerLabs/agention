// The diagram frame's script, which the server serves into a sandboxed frame
// at /diagram-frame: it draws Mermaid diagrams for its parent page and
// answers with their SVG. Mermaid runs only here, never in the app's page,
// so a diagram can reach neither the app nor the network: the frame's origin
// is opaque, and its own content security policy lets it load nothing.
//
// Opened on its own, rather than framed by a page, it does nothing.
import mermaid from "mermaid";
import { type DrawAnswer, type DrawRequest, readRequest } from "./protocol.ts";

// The longest error message passed back to the page.
const maxErrorLength = 500;

// draw renders one diagram, and returns its SVG with explicit dimensions, so
// that shown as an image it has its natural size, along with the title and
// description it declares.
async function draw({ id, source, theme }: DrawRequest): Promise<DrawAnswer> {
  const element = `diagram-${id}`;
  try {
    // Every setting is given on each draw, so none carries over from the
    // last. Strict is Mermaid's default security level, set here so that it
    // never depends on one; Mermaid's own limits stay at their defaults.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      suppressErrorRendering: true,
    });
    const { svg } = await mermaid.render(element, source);
    return { id, ...asImage(svg) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id, error: message.slice(0, maxErrorLength) };
  } finally {
    // A failed render may leave its working element behind.
    document.getElementById(element)?.remove();
    document.getElementById(`d${element}`)?.remove();
  }
}

// asImage turns Mermaid's SVG, written as HTML, into a standalone SVG
// document an image can show: well-formed XML, with the width and height of
// its view box in place of a width of 100%.
function asImage(svg: string): { svg: string; title?: string; description?: string } {
  // An HTML parse into a document of its own runs nothing and loads nothing.
  const parsed = new DOMParser().parseFromString(svg, "text/html");
  const root = parsed.body.querySelector("svg");
  if (root === null) {
    throw new Error("Mermaid returned no SVG");
  }
  const [, , width, height] = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    root.setAttribute("width", String(Math.ceil(width)));
    root.setAttribute("height", String(Math.ceil(height)));
    root.style.removeProperty("max-width");
  }
  const title = root.querySelector(":scope > title")?.textContent?.trim();
  const description = root.querySelector(":scope > desc")?.textContent?.trim();
  return {
    svg: new XMLSerializer().serializeToString(root),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

if (window.parent !== window) {
  // The frame's own address names the app's origin, which its parent has;
  // answers go only to a parent of that origin.
  const appOrigin = new URL(window.location.href).origin;
  // Requests are drawn one at a time, in the order they arrive.
  let drawing: Promise<void> = Promise.resolve();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) {
      return;
    }
    const request = readRequest(event.data);
    if (request === undefined) {
      return;
    }
    drawing = drawing.then(async () => {
      window.parent.postMessage(await draw(request), appOrigin);
    });
  });
}
