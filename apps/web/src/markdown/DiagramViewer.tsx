import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { SvgImage } from "./SvgImage.tsx";

// The diagram viewer: a diagram's image full screen, in a modal dialog, to
// zoom and pan by pinch, drag, double-tap and the wheel, by its buttons, and
// by the keys + and - to zoom, 0 to fit and 1 for actual size. Only its stage
// takes touches for itself, so the page keeps the browser's own zoom. Escape
// or Close closes it; onClose returns focus to the diagram.

// How far a zoom in or out moves the scale, and the scales it stays within,
// as fractions of the image's natural size. A diagram too long to fit at
// minScale can still zoom out as far as its fit, so it can be seen whole.
const step = 0.4;
const minScale = 0.05;
const maxScale = 8;

// Two taps within this many milliseconds and pixels of each other are a
// double tap; a pointer that moved further between down and up dragged.
const doubleTapMs = 300;
const tapSlop = 10;

export function DiagramViewer({
  svg,
  alt,
  onClose,
}: {
  svg: string;
  alt: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const panzoom = useRef<PanzoomObject>(undefined);

  // fitScale is the scale that shows the whole image in the stage, never
  // above its natural size.
  const fitScale = () => {
    const box = stage.current?.getBoundingClientRect();
    const img = image.current;
    if (box === undefined || img === null || img.naturalWidth === 0 || img.naturalHeight === 0) {
      return 1;
    }
    return Math.min(1, box.width / img.naturalWidth, box.height / img.naturalHeight);
  };
  const show = (scale: number) => {
    const zoom = panzoom.current;
    if (zoom !== undefined) {
      zoom.zoom(scale, { animate: false });
      zoom.pan(0, 0, { animate: false, force: true });
    }
  };
  const fit = () => {
    const scale = fitScale();
    panzoom.current?.setOptions({ minScale: Math.min(minScale, scale) });
    show(scale);
  };
  const actualSize = () => show(1);

  useLayoutEffect(() => {
    dialog.current?.showModal();
    const img = image.current;
    const area = stage.current;
    if (img === null || area === null) {
      return undefined;
    }
    const zoom = Panzoom(img, { canvas: true, step, minScale, maxScale, animate: false });
    panzoom.current = zoom;
    area.addEventListener("wheel", zoom.zoomWithWheel, { passive: false });

    // A double tap zooms in on the point tapped, or back out to fit.
    let downAt: { x: number; y: number } | undefined;
    let lastTap: { x: number; y: number; time: number } | undefined;
    const down = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY };
    };
    const up = (event: PointerEvent) => {
      const moved =
        downAt === undefined ||
        Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > tapSlop;
      if (moved) {
        lastTap = undefined;
        return;
      }
      const tap = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      if (
        lastTap !== undefined &&
        tap.time - lastTap.time < doubleTapMs &&
        Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < tapSlop * 3
      ) {
        lastTap = undefined;
        const scale = fitScale();
        if (zoom.getScale() > scale * 1.01) {
          fit();
        } else {
          zoom.zoomToPoint(Math.min(maxScale, scale * 2.5), event, { animate: false });
        }
        return;
      }
      lastTap = tap;
    };
    area.addEventListener("pointerdown", down);
    area.addEventListener("pointerup", up);

    // The image starts fitted to the stage, once its size is known.
    let open = true;
    void img
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (open) {
          fit();
        }
      });
    return () => {
      open = false;
      area.removeEventListener("wheel", zoom.zoomWithWheel);
      area.removeEventListener("pointerdown", down);
      area.removeEventListener("pointerup", up);
      zoom.destroy();
      panzoom.current = undefined;
    };
    // The viewer is set up once, as it opens; what it calls reads only refs.
  }, []);

  const keys: Record<string, () => void> = {
    "+": () => panzoom.current?.zoomIn({ animate: false }),
    "=": () => panzoom.current?.zoomIn({ animate: false }),
    "-": () => panzoom.current?.zoomOut({ animate: false }),
    "0": fit,
    "1": actualSize,
  };
  const keyDown = (event: KeyboardEvent) => {
    const action = event.altKey || event.ctrlKey || event.metaKey ? undefined : keys[event.key];
    if (action !== undefined) {
      event.preventDefault();
      action();
    }
  };

  return (
    <dialog ref={dialog} className="viewer" aria-label={alt} onClose={onClose} onKeyDown={keyDown}>
      <div className="viewer-bar">
        <button
          type="button"
          className="secondary"
          onClick={() => panzoom.current?.zoomIn({ animate: false })}
        >
          Zoom in
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => panzoom.current?.zoomOut({ animate: false })}
        >
          Zoom out
        </button>
        <button type="button" className="secondary" onClick={fit}>
          Fit
        </button>
        <button type="button" className="secondary" onClick={actualSize}>
          Actual size
        </button>
        <button type="button" className="viewer-close" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <div ref={stage} className="viewer-stage">
        <SvgImage svg={svg} alt={alt} image={image} draggable={false} />
      </div>
    </dialog>
  );
}
