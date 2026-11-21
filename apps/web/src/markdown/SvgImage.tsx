import { type RefObject, useLayoutEffect, useRef } from "react";

// SvgImage shows SVG text as an image, through a blob: URL that lives only
// until the image has loaded, or failed to. A blob: URL opened on its own, by
// browser navigation, is a document that takes no content security policy
// from the page that made it, so the SVG's own references would load there;
// once the image has loaded, no URL is left to open. The image keeps showing
// what it loaded, and new SVG text gets a URL of its own. image, when given,
// is the caller's hold on the image.
export function SvgImage({
  svg,
  alt,
  image,
  draggable,
}: {
  svg: string;
  alt: string;
  image?: RefObject<HTMLImageElement | null>;
  draggable?: boolean;
}) {
  const own = useRef<HTMLImageElement>(null);
  const img = image ?? own;
  // The URL is made and set before the image is painted, so it never shows
  // without its source.
  useLayoutEffect(() => {
    const element = img.current;
    if (element === null) {
      return undefined;
    }
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    // Revoking a URL already revoked does nothing.
    const revoke = () => URL.revokeObjectURL(url);
    element.addEventListener("load", revoke, { once: true });
    element.addEventListener("error", revoke, { once: true });
    element.src = url;
    return () => {
      element.removeEventListener("load", revoke);
      element.removeEventListener("error", revoke);
      revoke();
    };
  }, [svg, img]);
  return <img ref={img} alt={alt} draggable={draggable} />;
}
